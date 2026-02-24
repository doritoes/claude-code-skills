#!/usr/bin/env bun
/**
 * BigRedSync.ts - File Synchronization to BIGRED Local GPU Server
 *
 * Syncs wordlists, rules, and hashlists from local data dir to BIGRED's
 * hashcat-work directory via SSH/SCP. Idempotent — skips files that
 * already exist with matching size.
 *
 * Usage:
 *   bun Tools/BigRedSync.ts                      Sync changed wordlists + rules (md5 compare)
 *   bun Tools/BigRedSync.ts --hashlist batch-0008  Sync attack files + upload hashlist (main workflow command)
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
const SHELL = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";

interface BigRedConfig {
  host: string;
  user: string;
  sshKey: string;
  workDir: string;
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

  const workDir = env.BIGRED_WORK_DIR || `/home/${user}/hashcat-work`;

  return { host, user, sshKey: expandedKey, workDir };
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

function getFileManifest(workDir: string): SyncFile[] {
  return [
    // Wordlists
    {
      localPath: resolve(DATA_DIR, "nocap-plus.txt"),
      remotePath: `${workDir}/wordlists/nocap-plus.txt`,
      description: "nocap-plus.txt (combined wordlist, 14.4M words)",
    },
    {
      localPath: resolve(DATA_DIR, "nocap.txt"),
      remotePath: `${workDir}/wordlists/nocap.txt`,
      description: "nocap.txt (rockyou + rizzyou baseline)",
    },
    {
      localPath: resolve(PROJECT_ROOT, "rockyou.txt"),
      remotePath: `${workDir}/wordlists/rockyou.txt`,
      description: "rockyou.txt (original rockyou wordlist)",
    },
    {
      localPath: resolve(FEEDBACK_DIR, "BETA.txt"),
      remotePath: `${workDir}/wordlists/BETA.txt`,
      description: "BETA.txt (feedback roots)",
    },
    {
      localPath: resolve(FEEDBACK_DIR, "top-roots.txt"),
      remotePath: `${workDir}/wordlists/top-roots.txt`,
      description: "top-roots.txt (curated top 1K roots for long-password discovery)",
    },
    // Rules
    {
      localPath: resolve(DATA_DIR, "nocap.rule"),
      remotePath: `${workDir}/rules/nocap.rule`,
      description: "nocap.rule (48K rules)",
    },
    {
      localPath: resolve(FEEDBACK_DIR, "unobtainium.rule"),
      remotePath: `${workDir}/rules/UNOBTAINIUM.rule`,
      description: "UNOBTAINIUM.rule (diamond-derived rules)",
    },
    // Stage 1 rule
    {
      localPath: resolve(PROJECT_ROOT, "OneRuleToRuleThemStill.rule"),
      remotePath: `${workDir}/rules/OneRuleToRuleThemStill.rule`,
      description: "OneRuleToRuleThemStill.rule (48K optimized rules)",
    },
  ];
}

// =============================================================================
// Sync Logic
// =============================================================================

function getLocalMd5(filePath: string): string {
  // Use system md5sum — fast even for large files
  const cmd = process.platform === "win32"
    ? `certutil -hashfile "${filePath}" MD5`
    : `md5sum "${filePath}"`;
  try {
    const result = execSync(cmd, { encoding: "utf-8", shell: SHELL, timeout: 120000 }).trim();
    if (process.platform === "win32") {
      // certutil output: line 1 = header, line 2 = hash, line 3 = footer
      const lines = result.split("\n").map(l => l.trim());
      return (lines[1] || "").replace(/\s/g, "").toLowerCase();
    }
    return result.split(/\s/)[0].toLowerCase();
  } catch {
    return "";
  }
}

function getRemoteMd5(config: BigRedConfig, remotePath: string): string {
  try {
    const result = sshCmd(config, `md5sum ${remotePath} 2>/dev/null || echo MISSING`, 120000);
    if (result === "MISSING" || result.includes("No such file")) return "";
    return result.split(/\s/)[0].toLowerCase();
  } catch {
    return "";
  }
}

async function syncFile(config: BigRedConfig, file: SyncFile, force: boolean): Promise<boolean> {
  if (!existsSync(file.localPath)) {
    console.log(`  SKIP  ${file.description} — local file not found`);
    return false;
  }

  const localSize = statSync(file.localPath).size;
  const localMd5 = getLocalMd5(file.localPath);
  const remoteMd5 = getRemoteMd5(config, file.remotePath);

  if (remoteMd5 === "") {
    // File missing on BIGRED
    console.log(`  UPLOAD  ${file.description} (${formatSize(localSize)})...`);
    scpUpload(config, file.localPath, file.remotePath);
    console.log(`          Done.`);
    return true;
  }

  if (!force && localMd5 === remoteMd5) {
    console.log(`  OK      ${file.description} (${formatSize(localSize)}, md5 match)`);
    return false;
  }

  if (force && localMd5 === remoteMd5) {
    console.log(`  OK      ${file.description} (${formatSize(localSize)}, md5 match — skip)`);
    return false;
  }

  console.log(`  UPDATE  ${file.description} (${formatSize(localSize)}, md5 changed)...`);
  scpUpload(config, file.localPath, file.remotePath);
  console.log(`          Done.`);
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
  const remotePath = `${config.workDir}/hashlists/${batchName}.txt`;

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

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  let hashlist: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--hashlist":
        hashlist = args[++i];
        break;
      case "--help":
      case "-h":
        console.log(`
BigRedSync - File Synchronization to BIGRED GPU Server

Usage:
  bun Tools/BigRedSync.ts                       Sync all wordlists + rules (md5 compare)
  bun Tools/BigRedSync.ts --hashlist batch-0008  Sync attack files + upload hashlist

Configuration: .env (BIGRED_HOST, BIGRED_USER, BIGRED_SSH_KEY, BIGRED_WORK_DIR)
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

    // Ensure remote directories exist
    sshCmd(config, `mkdir -p ${config.workDir}/{wordlists,rules,hashlists,potfiles,results}`);

    // Sync all attack files (md5 compare, upload only changes)
    console.log(`\nSyncing attack files...`);
    const manifest = getFileManifest(config.workDir);
    const missing: string[] = [];
    let uploaded = 0;

    for (const file of manifest) {
      if (!existsSync(file.localPath)) {
        missing.push(file.description);
        continue;
      }
      const changed = await syncFile(config, file, false);
      if (changed) uploaded++;
    }

    if (missing.length > 0) {
      console.error(`\nBLOCKED: ${missing.length} local file(s) not found:`);
      for (const m of missing) console.error(`  ${m}`);
      process.exit(1);
    }

    if (uploaded > 0) {
      console.log(`  ${uploaded} file(s) updated on BIGRED.`);
    } else {
      console.log(`  All ${manifest.length} attack files up to date.`);
    }

    if (hashlist) {
      console.log(`\nUploading hashlist: ${hashlist}`);
      await syncHashlist(config, hashlist);

      const batchNum = hashlist.replace("batch-", "").replace(/^0+/, "") || "0";
      console.log(`\nReady: bun Tools/BigRedRunner.ts --batch ${batchNum}`);
    }

    console.log("\nDone.");
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

export { loadConfig, sshCmd, scpUpload, scpDownload, type BigRedConfig };
