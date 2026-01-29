#!/usr/bin/env bun
/**
 * AuditLog.ts - Audit logging utility for FoldingAtCloud
 *
 * Provides consistent audit logging for all destructive operations.
 * Log format: timestamp | action | provider | target | details | result
 *
 * Commands:
 *   log <action> <provider> <target> <details> <result>    Add log entry
 *   show [lines]                                           Show recent entries
 *   search <term>                                          Search log entries
 *   clear                                                  Clear audit log (with backup)
 *
 * Usage:
 *   bun run AuditLog.ts log STOP azure pai-fold-1 "20.120.1.100" "SUCCESS"
 *   bun run AuditLog.ts show 20
 *   bun run AuditLog.ts search "STOP"
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { join, dirname } from "path";

// Paths
const SCRIPT_DIR = dirname(import.meta.path);
const SKILL_DIR = join(SCRIPT_DIR, "..");
const LOGS_DIR = join(SKILL_DIR, "logs");
const AUDIT_LOG = join(LOGS_DIR, "audit.log");

/**
 * Ensure logs directory exists
 */
function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Add entry to audit log
 */
function logEntry(
  action: string,
  provider: string,
  target: string,
  details: string,
  result: string
): string {
  ensureLogsDir();

  const timestamp = new Date().toISOString();
  const entry = `${timestamp} | ${action} | ${provider} | ${target} | ${details} | ${result}`;

  appendFileSync(AUDIT_LOG, entry + "\n");

  return entry;
}

/**
 * Show recent log entries
 */
function showLog(lines: number = 50): string[] {
  if (!existsSync(AUDIT_LOG)) {
    return [];
  }

  const content = readFileSync(AUDIT_LOG, "utf-8");
  const allLines = content.trim().split("\n").filter((l) => l.length > 0);

  return allLines.slice(-lines);
}

/**
 * Search log entries
 */
function searchLog(term: string): string[] {
  if (!existsSync(AUDIT_LOG)) {
    return [];
  }

  const content = readFileSync(AUDIT_LOG, "utf-8");
  const allLines = content.trim().split("\n");

  return allLines.filter((line) =>
    line.toLowerCase().includes(term.toLowerCase())
  );
}

/**
 * Clear audit log (creates backup first)
 */
function clearLog(): string {
  if (!existsSync(AUDIT_LOG)) {
    return "No audit log to clear";
  }

  // Create backup
  const backupPath = `${AUDIT_LOG}.${Date.now()}.bak`;
  copyFileSync(AUDIT_LOG, backupPath);

  // Clear log with header
  writeFileSync(AUDIT_LOG, `# Audit log cleared at ${new Date().toISOString()}\n# Backup: ${backupPath}\n`);

  return `Log cleared. Backup at: ${backupPath}`;
}

/**
 * Get log statistics
 */
function getStats(): Record<string, number> {
  if (!existsSync(AUDIT_LOG)) {
    return {};
  }

  const content = readFileSync(AUDIT_LOG, "utf-8");
  const lines = content.trim().split("\n").filter((l) => !l.startsWith("#"));

  const stats: Record<string, number> = {
    total_entries: lines.length,
    STOP: 0,
    DESTROY: 0,
    FINISH: 0,
    SUCCESS: 0,
    FAILED: 0,
    REJECTED: 0,
  };

  for (const line of lines) {
    if (line.includes("| STOP")) stats.STOP++;
    if (line.includes("| DESTROY")) stats.DESTROY++;
    if (line.includes("| FINISH")) stats.FINISH++;
    if (line.includes("SUCCESS")) stats.SUCCESS++;
    if (line.includes("FAILED")) stats.FAILED++;
    if (line.includes("REJECTED")) stats.REJECTED++;
  }

  return stats;
}

// =============================================================================
// Main CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(`
AuditLog - Audit logging utility for FoldingAtCloud

Usage:
  bun run AuditLog.ts <command> [args]

Commands:
  log <action> <provider> <target> <details> <result>    Add log entry
  show [lines]                                           Show recent entries (default: 50)
  search <term>                                          Search log entries
  stats                                                  Show log statistics
  clear                                                  Clear log (creates backup)

Log Format:
  timestamp | action | provider | target | details | result

Common Actions:
  FINISH_SENT      - Finish signal sent to worker
  STOP_INITIATED   - VM stop command initiated
  STOP_SUCCESS     - VM stop completed
  STOP_FAILED      - VM stop failed
  STOP_REJECTED    - VM stop rejected (safety check failed)
  DESTROY_INITIATED - Terraform destroy initiated
  DESTROY_SUCCESS  - Terraform destroy completed

Examples:
  bun run AuditLog.ts log STOP_SUCCESS azure pai-fold-1 "20.120.1.100" "Deallocated"
  bun run AuditLog.ts show 20
  bun run AuditLog.ts search "REJECTED"
  bun run AuditLog.ts stats

Log Location: ${AUDIT_LOG}
`);
    process.exit(1);
  }

  const command = args[0];

  switch (command) {
    case "log": {
      const action = args[1];
      const provider = args[2];
      const target = args[3];
      const details = args[4];
      const result = args[5];

      if (!action || !provider || !target || !details || !result) {
        console.error("Usage: log <action> <provider> <target> <details> <result>");
        process.exit(1);
      }

      const entry = logEntry(action, provider, target, details, result);
      console.log("Logged:", entry);
      break;
    }

    case "show": {
      const lines = parseInt(args[1]) || 50;
      const entries = showLog(lines);

      if (entries.length === 0) {
        console.log("No audit log entries");
      } else {
        console.log(`Last ${entries.length} entries:\n`);
        entries.forEach((e) => console.log(e));
      }
      break;
    }

    case "search": {
      const term = args[1];
      if (!term) {
        console.error("Usage: search <term>");
        process.exit(1);
      }

      const results = searchLog(term);

      if (results.length === 0) {
        console.log(`No entries matching: ${term}`);
      } else {
        console.log(`Found ${results.length} entries:\n`);
        results.forEach((e) => console.log(e));
      }
      break;
    }

    case "stats": {
      const stats = getStats();
      console.log(JSON.stringify(stats, null, 2));
      break;
    }

    case "clear": {
      const message = clearLog();
      console.log(message);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
