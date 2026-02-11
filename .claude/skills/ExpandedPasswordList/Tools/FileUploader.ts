#!/usr/bin/env bun
/**
 * FileUploader.ts - Upload Attack Files to Hashtopolis
 *
 * Uploads wordlists and rule files to the Hashtopolis server and registers
 * them in the File table for use in attacks.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const HASHCRACK_DIR = resolve(SKILL_DIR, "..", "Hashcrack");
const TERRAFORM_DIR = resolve(HASHCRACK_DIR, "terraform", "aws");

// =============================================================================
// Server Configuration
// =============================================================================

interface ServerConfig {
  serverIp: string;
  dbPassword: string;
  sshUser: string;
}

function getServerConfig(): ServerConfig {
  try {
    const serverIp = execSync(`terraform output -raw server_ip`, {
      encoding: "utf-8",
      cwd: TERRAFORM_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const dbPassword = execSync(`terraform output -raw db_password`, {
      encoding: "utf-8",
      cwd: TERRAFORM_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { serverIp, dbPassword, sshUser: "ubuntu" };
  } catch (e) {
    throw new Error("Cannot get server config from terraform");
  }
}

function execSQL(config: ServerConfig, sql: string): string {
  const cleanSql = sql.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  const b64Sql = Buffer.from(cleanSql).toString("base64");
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${config.sshUser}@${config.serverIp} "echo ${b64Sql} | base64 -d | sudo docker exec -i hashtopolis-db mysql -u hashtopolis -p'${config.dbPassword}' hashtopolis -sN"`;
  try {
    const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
    return execSync(cmd, { encoding: "utf-8", timeout: 60000, shell }).trim();
  } catch (e) {
    console.error("SQL error:", (e as Error).message);
    return "";
  }
}

// =============================================================================
// File Processing
// =============================================================================

/**
 * Clean a wordlist file by removing comments and empty lines
 */
function cleanWordlist(inputPath: string): string {
  const content = readFileSync(inputPath, "utf-8");
  const lines = content.split("\n");
  const cleanLines: string[] = [];

  for (const line of lines) {
    // Skip comment lines
    if (line.trim().startsWith("#")) continue;
    // Skip empty lines
    if (!line.trim()) continue;
    // Remove inline comments (everything after #)
    const cleanLine = line.split("#")[0].trim();
    if (cleanLine) {
      cleanLines.push(cleanLine);
    }
  }

  return cleanLines.join("\n") + "\n";
}

/**
 * Get the next available fileId
 */
function getNextFileId(config: ServerConfig): number {
  const result = execSQL(config, "SELECT COALESCE(MAX(fileId), 0) + 1 FROM File");
  return parseInt(result) || 1;
}

/**
 * Check if a file with the given name already exists
 */
function findFileByName(config: ServerConfig, filename: string): number | null {
  const result = execSQL(config, `SELECT fileId FROM File WHERE filename = '${filename}' LIMIT 1`);
  return result ? parseInt(result) : null;
}

/**
 * Upload a file to the Hashtopolis server
 */
async function uploadFile(
  config: ServerConfig,
  localPath: string,
  options: {
    targetFileId?: number;
    filename?: string;
    isWordlist?: boolean;
    cleanComments?: boolean;
    replace?: boolean;
  } = {}
): Promise<{ fileId: number; filename: string; size: number }> {
  const { isWordlist = true, cleanComments = true } = options;

  if (!existsSync(localPath)) {
    throw new Error(`File not found: ${localPath}`);
  }

  const originalFilename = basename(localPath);
  const filename = options.filename || originalFilename;

  // Determine file type (0 = wordlist, 1 = rule)
  const fileType = filename.endsWith(".rule") ? 1 : 0;

  console.log(`\nUploading: ${localPath}`);
  console.log(`  Target filename: ${filename}`);
  console.log(`  File type: ${fileType === 0 ? "wordlist" : "rule"}`);

  // Prepare file content
  let content: string;
  if (cleanComments && fileType === 0) {
    console.log("  Cleaning comments from wordlist...");
    content = cleanWordlist(localPath);
  } else {
    content = readFileSync(localPath, "utf-8");
  }

  const size = Buffer.byteLength(content, "utf-8");
  console.log(`  Size: ${(size / 1024).toFixed(1)} KB (${content.split("\n").length - 1} lines)`);

  // Create temp file for upload
  const tempPath = resolve(DATA_DIR, `.upload-temp-${Date.now()}.txt`);
  writeFileSync(tempPath, content);

  try {
    // Check if file already exists
    const existingId = findFileByName(config, filename);
    let replacing = false;
    let fileId: number;

    if (existingId && options.replace) {
      // Replace mode: reuse existing fileId, overwrite file content
      fileId = existingId;
      replacing = true;
      console.log(`  Replacing existing file (fileId ${fileId})...`);
    } else if (existingId && !options.targetFileId) {
      console.log(`  File already exists as fileId ${existingId}`);
      unlinkSync(tempPath);
      return { fileId: existingId, filename, size };
    } else if (options.targetFileId) {
      fileId = options.targetFileId;
      // Check if target fileId is already used
      const existing = execSQL(config, `SELECT filename FROM File WHERE fileId = ${fileId}`);
      if (existing) {
        if (options.replace) {
          replacing = true;
          console.log(`  Replacing existing file at fileId ${fileId}...`);
        } else {
          throw new Error(`fileId ${fileId} already used by: ${existing}`);
        }
      }
    } else {
      fileId = getNextFileId(config);
    }

    console.log(`  ${replacing ? "Replacing" : "Assigned"} fileId: ${fileId}`);

    // Upload file to server host
    console.log("  Uploading to server...");
    const remotePath = `/tmp/upload-${filename}`;
    const scpCmd = `scp -o StrictHostKeyChecking=no "${tempPath}" ${config.sshUser}@${config.serverIp}:${remotePath}`;
    execSync(scpCmd, { encoding: "utf-8", timeout: 120000 });

    // Copy into Docker container, then to both Hashtopolis directories
    console.log("  Copying to Hashtopolis directories...");
    // First copy file into container
    const dockerCpCmd = `ssh -o StrictHostKeyChecking=no ${config.sshUser}@${config.serverIp} "sudo docker cp ${remotePath} hashtopolis-backend:/tmp/${filename}"`;
    execSync(dockerCpCmd, { encoding: "utf-8", timeout: 60000 });

    // Then copy to both locations inside container (run as root to handle permissions)
    const copyCmd = `ssh -o StrictHostKeyChecking=no ${config.sshUser}@${config.serverIp} "` +
      `sudo docker exec -u root hashtopolis-backend bash -c '` +
      `cp /tmp/${filename} /var/www/hashtopolis/files/${filename} && ` +
      `chown www-data:www-data /var/www/hashtopolis/files/${filename} && ` +
      `mkdir -p /usr/local/share/hashtopolis/files && ` +
      `cp /tmp/${filename} /usr/local/share/hashtopolis/files/${filename} && ` +
      `chown www-data:www-data /usr/local/share/hashtopolis/files/${filename} && ` +
      `rm /tmp/${filename}' && ` +
      `rm ${remotePath}"`;
    execSync(copyCmd, { encoding: "utf-8", timeout: 60000 });

    if (replacing) {
      // Update size in database
      console.log("  Updating file size in database...");
      execSQL(config, `UPDATE File SET size = ${size} WHERE fileId = ${fileId}`);
    } else {
      // Register new file in database
      console.log("  Registering in File table...");
      const insertSql = `INSERT INTO File (fileId, filename, size, isSecret, fileType, accessGroupId) VALUES (${fileId}, '${filename}', ${size}, 1, ${fileType}, 1)`;
      execSQL(config, insertSql);
    }

    // Verify registration
    const verify = execSQL(config, `SELECT fileId, filename, size FROM File WHERE fileId = ${fileId}`);
    if (!verify) {
      throw new Error("File registration failed - not found in database");
    }

    console.log(`  ✓ ${replacing ? "Replaced" : "Uploaded and registered as"} fileId ${fileId}`);

    return { fileId, filename, size };
  } finally {
    // Cleanup temp file
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
}

/**
 * List all files in Hashtopolis
 */
function listFiles(config: ServerConfig): void {
  const result = execSQL(config, "SELECT fileId, filename, size, isSecret, fileType FROM File ORDER BY fileId");

  console.log("\nHashtopolis Files:");
  console.log("─".repeat(70));
  console.log("ID    Filename                              Size        Type");
  console.log("─".repeat(70));

  if (!result) {
    console.log("(no files found)");
    return;
  }

  for (const line of result.split("\n")) {
    if (!line.trim()) continue;
    const [id, name, size, secret, type] = line.split("\t");
    const sizeStr = parseInt(size) > 1000000
      ? `${(parseInt(size) / 1024 / 1024).toFixed(1)} MB`
      : `${(parseInt(size) / 1024).toFixed(1)} KB`;
    const typeStr = type === "1" ? "rule" : "wordlist";
    console.log(`${id.padEnd(6)}${name.padEnd(38)}${sizeStr.padStart(10)}    ${typeStr}`);
  }
  console.log("─".repeat(70));
}

/**
 * Verify file downloads work
 */
async function verifyFileDownloads(config: ServerConfig, fileIds: number[]): Promise<boolean> {
  const token = execSQL(config, "SELECT token FROM Agent WHERE isActive=1 LIMIT 1");
  if (!token) {
    console.log("⚠ No active agents to test downloads");
    return false;
  }

  console.log("\nVerifying file downloads...");
  let allOk = true;

  for (const fileId of fileIds) {
    const sizeCmd = `ssh -o StrictHostKeyChecking=no ${config.sshUser}@${config.serverIp} "curl -s -w '%{size_download}' -o /dev/null 'http://localhost:8080/getFile.php?file=${fileId}&token=${token}'"`;
    try {
      const size = parseInt(execSync(sizeCmd, { encoding: "utf-8", timeout: 60000 }).trim());
      if (size < 100) {
        console.log(`  ✗ File ${fileId}: Download failed (${size} bytes - likely ERR3)`);
        allOk = false;
      } else {
        console.log(`  ✓ File ${fileId}: ${(size / 1024).toFixed(1)} KB`);
      }
    } catch (e) {
      console.log(`  ✗ File ${fileId}: Download error`);
      allOk = false;
    }
  }

  return allOk;
}

// =============================================================================
// CLI
// =============================================================================

function printHelp(): void {
  console.log(`
FileUploader - Upload Attack Files to Hashtopolis

Usage:
  bun FileUploader.ts --upload <file>              Upload a file
  bun FileUploader.ts --upload <file> --id <n>     Upload with specific fileId
  bun FileUploader.ts --upload <file> --replace     Replace existing file content
  bun FileUploader.ts --list                       List all files
  bun FileUploader.ts --verify <id1,id2,...>       Verify file downloads
  bun FileUploader.ts --upload-rizzyou             Upload rizzyou.txt as fileId 4

Options:
  --upload <path>    Path to file to upload (relative to data/ or absolute)
  --id <n>           Force specific fileId (default: next available)
  --name <filename>  Override filename in Hashtopolis
  --replace          Replace existing file (overwrite content + update DB size)
  --no-clean         Don't strip comments from wordlists
  --list             List all files in Hashtopolis
  --verify <ids>     Verify file downloads work (comma-separated IDs)

Examples:
  bun FileUploader.ts --upload rizzyou.txt --id 4
  bun FileUploader.ts --upload nocap-plus.txt --replace
  bun FileUploader.ts --upload data/GenZ.rule
  bun FileUploader.ts --list
  bun FileUploader.ts --verify 1,3,4,5,6
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printHelp();
    return;
  }

  const config = getServerConfig();
  console.log(`Server: ${config.serverIp}`);

  // List files
  if (args.includes("--list")) {
    listFiles(config);
    return;
  }

  // Verify downloads
  const verifyIdx = args.indexOf("--verify");
  if (verifyIdx !== -1) {
    const idsStr = args[verifyIdx + 1];
    if (!idsStr) {
      console.error("--verify requires comma-separated file IDs");
      process.exit(1);
    }
    const ids = idsStr.split(",").map(s => parseInt(s.trim()));
    await verifyFileDownloads(config, ids);
    return;
  }

  // Quick upload for rizzyou.txt
  if (args.includes("--upload-rizzyou")) {
    const rizzyouPath = resolve(DATA_DIR, "rizzyou.txt");
    if (!existsSync(rizzyouPath)) {
      console.error(`rizzyou.txt not found at ${rizzyouPath}`);
      process.exit(1);
    }
    const result = await uploadFile(config, rizzyouPath, {
      targetFileId: 4,
      filename: "rizzyou.txt",
      cleanComments: true,
    });
    console.log(`\n✓ rizzyou.txt uploaded as fileId ${result.fileId}`);

    // Verify download works
    await verifyFileDownloads(config, [result.fileId]);
    return;
  }

  // Upload file
  const uploadIdx = args.indexOf("--upload");
  if (uploadIdx !== -1) {
    let filePath = args[uploadIdx + 1];
    if (!filePath) {
      console.error("--upload requires a file path");
      process.exit(1);
    }

    // Resolve path relative to data/ if not absolute
    if (!filePath.includes("/") && !filePath.includes("\\")) {
      filePath = resolve(DATA_DIR, filePath);
    }

    // Parse options
    const idIdx = args.indexOf("--id");
    const targetFileId = idIdx !== -1 ? parseInt(args[idIdx + 1]) : undefined;

    const nameIdx = args.indexOf("--name");
    const filename = nameIdx !== -1 ? args[nameIdx + 1] : undefined;

    const cleanComments = !args.includes("--no-clean");
    const replace = args.includes("--replace");

    const result = await uploadFile(config, filePath, {
      targetFileId,
      filename,
      cleanComments,
      replace,
    });

    console.log(`\n✓ Uploaded: ${result.filename} (fileId ${result.fileId}, ${result.size} bytes)`);

    // Verify download
    await verifyFileDownloads(config, [result.fileId]);
    return;
  }

  printHelp();
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
