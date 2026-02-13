#!/usr/bin/env bun
/**
 * BigRedSync.ts - File Synchronization to BIGRED Local GPU Server
 *
 * Syncs wordlists, rules, and hashlists from local data dir to BIGRED's
 * hashcat-work directory via SSH/SCP. Idempotent — skips files that
 * already exist with matching size.
 *
 * Usage:
 *   bun Tools/BigRedSync.ts                      Sync all wordlists + rules
 *   bun Tools/BigRedSync.ts --force               Re-upload everything
 *   bun Tools/BigRedSync.ts --hashlist batch-0008  Upload specific batch hashlist
 *   bun Tools/BigRedSync.ts --status              Show remote file status
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { DATA_DIR, SAND_DIR, FEEDBACK_DIR } from "./config";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const PROJECT_ROOT = resolve(SKILL_DIR, "..", "..", "..");

// =============================================================================
// Configuration
// =============================================================================

const ENV_PATH = resolve(__dirname, "..", "..", "..", ".env");
const WORK_DIR = "/home/pai/hashcat-work";
const SHELL = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";

interface BigRedConfig {
  host: string;
  user: string;
  sshKey: string;
}

function loadConfig(): BigRedConfig {
  if (!existsSync(ENV_PATH)) {
    throw new Error(`.env not found at ${ENV_PATH}`);
  }

  const env: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }

  const host = env.BIGRED_HOST;
  const user = env.BIGRED_USER;
  const sshKey = env.BIGRED_SSH_KEY;

  if (!host || !user || !sshKey) {
    throw new Error("Missing BIGRED_HOST, BIGRED_USER, or BIGRED_SSH_KEY in .env");
  }

  // Expand ~ in SSH key path
  const expandedKey = sshKey.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "~");

  return { host, user, sshKey: expandedKey };
}

// =============================================================================
// SSH Helpers
// =============================================================================

function sshCmd(config: BigRedConfig, cmd: string, timeout = 30000): string {
  const fullCmd = `ssh -i "${config.sshKey}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${config.user}@${config.host} "${cmd.replace(/"/g, '\\"')}"`;
  try {
    return execSync(fullCmd, { encoding: "utf-8", timeout, shell: SHELL }).trim();
  } catch (e) {
    throw new Error(`SSH command failed: ${cmd}\n${(e as Error).message}`);
  }
}

function scpUpload(config: BigRedConfig, localPath: string, remotePath: string, timeout = 600000): void {
  // Convert Windows path to MSYS path for scp
  let msysPath = localPath;
  if (process.platform === "win32") {
    msysPath = localPath.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d) => `/${d.toLowerCase()}`);
  }

  const cmd = `scp -i "${config.sshKey}" -o StrictHostKeyChecking=no "${msysPath}" ${config.user}@${config.host}:${remotePath}`;
  try {
    execSync(cmd, { encoding: "utf-8", timeout, shell: SHELL, stdio: "pipe" });
  } catch (e) {
    throw new Error(`SCP upload failed: ${localPath} → ${remotePath}\n${(e as Error).message}`);
  }
}

function scpDownload(config: BigRedConfig, remotePath: string, localPath: string, timeout = 600000): void {
  let msysPath = localPath;
  if (process.platform === "win32") {
    msysPath = localPath.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d) => `/${d.toLowerCase()}`);
  }

  const cmd = `scp -i "${config.sshKey}" -o StrictHostKeyChecking=no ${config.user}@${config.host}:${remotePath} "${msysPath}"`;
  try {
    execSync(cmd, { encoding: "utf-8", timeout, shell: SHELL, stdio: "pipe" });
  } catch (e) {
    throw new Error(`SCP download failed: ${remotePath} → ${localPath}\n${(e as Error).message}`);
  }
}

// =============================================================================
// File Manifest
// =============================================================================

interface SyncFile {
  localPath: string;
  remotePath: string;
  description: string;
}

function getFileManifest(): SyncFile[] {
  return [
    // Wordlists
    {
      localPath: resolve(DATA_DIR, "nocap-plus.txt"),
      remotePath: `${WORK_DIR}/wordlists/nocap-plus.txt`,
      description: "nocap-plus.txt (combined wordlist, 14.4M words)",
    },
    {
      localPath: resolve(DATA_DIR, "nocap.txt"),
      remotePath: `${WORK_DIR}/wordlists/nocap.txt`,
      description: "nocap.txt (rockyou + rizzyou baseline)",
    },
    {
      localPath: resolve(PROJECT_ROOT, "rockyou.txt"),
      remotePath: `${WORK_DIR}/wordlists/rockyou.txt`,
      description: "rockyou.txt (original rockyou wordlist)",
    },
    {
      localPath: resolve(FEEDBACK_DIR, "BETA.txt"),
      remotePath: `${WORK_DIR}/wordlists/BETA.txt`,
      description: "BETA.txt (feedback roots)",
    },
    // Rules
    {
      localPath: resolve(DATA_DIR, "nocap.rule"),
      remotePath: `${WORK_DIR}/rules/nocap.rule`,
      description: "nocap.rule (48K rules)",
    },
    {
      localPath: resolve(FEEDBACK_DIR, "unobtainium.rule"),
      remotePath: `${WORK_DIR}/rules/UNOBTAINIUM.rule`,
      description: "UNOBTAINIUM.rule (diamond-derived rules)",
    },
  ];
}

// =============================================================================
// Sync Logic
// =============================================================================

async function getRemoteFileSize(config: BigRedConfig, remotePath: string): Promise<number> {
  try {
    const result = sshCmd(config, `stat -c %s ${remotePath} 2>/dev/null || echo -1`);
    return parseInt(result) || -1;
  } catch {
    return -1;
  }
}

async function syncFile(config: BigRedConfig, file: SyncFile, force: boolean): Promise<boolean> {
  // Check local file exists
  if (!existsSync(file.localPath)) {
    console.log(`  SKIP  ${file.description} — local file not found`);
    return false;
  }

  const localSize = statSync(file.localPath).size;
  const remoteSize = await getRemoteFileSize(config, file.remotePath);

  if (!force && remoteSize === localSize) {
    console.log(`  OK    ${file.description} (${formatSize(localSize)})`);
    return false;
  }

  const action = remoteSize === -1 ? "UPLOAD" : "UPDATE";
  console.log(`  ${action}  ${file.description} (${formatSize(localSize)})...`);

  scpUpload(config, file.localPath, file.remotePath);
  console.log(`        Done.`);
  return true;
}

async function syncHashlist(config: BigRedConfig, batchName: string): Promise<boolean> {
  // Normalize batch name
  if (!batchName.startsWith("batch-")) {
    const num = parseInt(batchName);
    batchName = `batch-${String(num).padStart(4, "0")}`;
  }

  const gzPath = resolve(SAND_DIR, `${batchName}.txt.gz`);
  const txtPath = resolve(SAND_DIR, `${batchName}.txt`);
  const remotePath = `${WORK_DIR}/hashlists/${batchName}.txt`;

  let hashes: string;
  if (existsSync(gzPath)) {
    console.log(`  Decompressing ${batchName}.txt.gz...`);
    const compressed = readFileSync(gzPath);
    hashes = gunzipSync(compressed).toString("utf-8");
  } else if (existsSync(txtPath)) {
    hashes = readFileSync(txtPath, "utf-8");
  } else {
    console.error(`  ERROR: Batch file not found: ${gzPath} or ${txtPath}`);
    return false;
  }

  // Write decompressed to temp, then SCP
  const tmpPath = resolve(SAND_DIR, `${batchName}.tmp.txt`);
  const { writeFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(tmpPath, hashes);

  const lineCount = hashes.trim().split("\n").length;
  console.log(`  UPLOAD ${batchName}.txt (${lineCount.toLocaleString()} hashes, ${formatSize(Buffer.byteLength(hashes))})...`);

  try {
    scpUpload(config, tmpPath, remotePath);
    console.log(`        Done.`);
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }

  return true;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

async function showStatus(config: BigRedConfig): Promise<void> {
  console.log("\nBIGRED File Status");
  console.log("==================");
  console.log(`Host: ${config.host} (user: ${config.user})\n`);

  const result = sshCmd(config, `find ${WORK_DIR} -type f -exec ls -lh {} \\; 2>/dev/null | sort`);
  if (!result) {
    console.log("  (no files found)");
    return;
  }

  // Parse and display
  for (const line of result.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(/\s+/);
    const size = parts[4] || "?";
    const path = parts[parts.length - 1] || "";
    const relPath = path.replace(WORK_DIR + "/", "");
    console.log(`  ${relPath.padEnd(45)} ${size}`);
  }

  // GPU status
  console.log("\nGPU Status:");
  try {
    const gpu = sshCmd(config, "nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || echo 'nvidia-smi not available'");
    console.log(`  ${gpu}`);
  } catch {
    console.log("  (nvidia-smi not available)");
  }
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  let force = false;
  let hashlist: string | undefined;
  let statusOnly = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--force":
        force = true;
        break;
      case "--hashlist":
        hashlist = args[++i];
        break;
      case "--status":
        statusOnly = true;
        break;
      case "--help":
      case "-h":
        console.log(`
BigRedSync - File Synchronization to BIGRED GPU Server

Usage:
  bun Tools/BigRedSync.ts                       Sync all wordlists + rules
  bun Tools/BigRedSync.ts --force                Re-upload everything
  bun Tools/BigRedSync.ts --hashlist batch-0008  Upload specific batch hashlist
  bun Tools/BigRedSync.ts --status               Show remote file status

Configuration: .env (BIGRED_HOST, BIGRED_USER, BIGRED_SSH_KEY)
Remote dir:    ${WORK_DIR}
`);
        process.exit(0);
    }
  }

  try {
    const config = loadConfig();
    console.log(`BIGRED: ${config.user}@${config.host}`);

    // Test connectivity
    try {
      sshCmd(config, "echo connected", 10000);
    } catch {
      console.error("ERROR: Cannot connect to BIGRED. Check network and SSH key.");
      process.exit(1);
    }

    if (statusOnly) {
      await showStatus(config);
      process.exit(0);
    }

    // Ensure remote directories exist
    sshCmd(config, `mkdir -p ${WORK_DIR}/{wordlists,rules,hashlists,potfiles,results}`);

    if (hashlist) {
      // Upload specific hashlist
      console.log(`\nSyncing hashlist: ${hashlist}`);
      await syncHashlist(config, hashlist);
    } else {
      // Sync all standard files
      console.log(`\nSyncing attack files${force ? " (FORCE)" : ""}:`);
      const manifest = getFileManifest();
      let uploaded = 0;

      for (const file of manifest) {
        const changed = await syncFile(config, file, force);
        if (changed) uploaded++;
      }

      if (uploaded === 0) {
        console.log("\nAll files up to date.");
      } else {
        console.log(`\n${uploaded} file(s) uploaded.`);
      }
    }

    console.log("\nDone.");
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

export { loadConfig, sshCmd, scpUpload, scpDownload, WORK_DIR, type BigRedConfig };
