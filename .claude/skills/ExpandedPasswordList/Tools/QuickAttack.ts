#!/usr/bin/env bun
/**
 * QuickAttack.ts - Submit one-off attacks to existing Hashtopolis hashlists
 *
 * For attacks outside the regular SAND pipeline. Links to existing hashlists
 * or uploads new ones as needed.
 *
 * @author PAI (Personal AI Infrastructure)
 */

import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_DIR = dirname(__dirname);

// Attack presets
const ATTACKS: Record<string, {
  name: string;
  cmd: string;
  priority: number;
  isSmall: boolean;
  description: string;
}> = {
  "brute-1-4": {
    name: "brute-1-4",
    cmd: "#HL# -a 3 ?a?a?a?a --increment --increment-min 1",
    priority: 95,
    isSmall: true,
    description: "Brute force 1-4 characters (trivial keyspace)",
  },
  "brute-5": {
    name: "brute-5",
    cmd: "#HL# -a 3 ?a?a?a?a?a",
    priority: 92,
    isSmall: true,
    description: "Brute force 5 characters",
  },
  "brute-6": {
    name: "brute-6",
    cmd: "#HL# -a 3 ?a?a?a?a?a?a",
    priority: 89,
    isSmall: false,
    description: "Brute force 6 characters",
  },
  "brute-7": {
    name: "brute-7",
    cmd: "#HL# -a 3 ?a?a?a?a?a?a?a",
    priority: 86,
    isSmall: false,
    description: "Brute force 7 characters",
  },
  "brute-8": {
    name: "brute-8",
    cmd: "#HL# -a 3 ?a?a?a?a?a?a?a?a",
    priority: 85,
    isSmall: false,
    description: "Brute force 8 characters (~51 hours)",
  },
};

interface ServerConfig {
  serverIp: string;
  serverUrl: string;
  apiKey: string;
  dbPass: string;
}

function getServerConfig(): ServerConfig {
  const envPath = resolve(SKILL_DIR, "../../.env");
  const env = require("dotenv").config({ path: envPath }).parsed || {};

  const serverUrl = env.HASHCRACK_SERVER_URL || process.env.HASHCRACK_SERVER_URL || "";
  const serverIp = serverUrl.replace(/https?:\/\//, "").replace(/:\d+.*/, "");

  return {
    serverIp,
    serverUrl,
    apiKey: env.HASHCRACK_API_KEY || process.env.HASHCRACK_API_KEY || "",
    dbPass: env.HASHCRACK_DB_PASSWORD || process.env.HASHCRACK_DB_PASSWORD || "",
  };
}

async function getHashlistInfo(config: ServerConfig, hashlistId: number): Promise<{exists: boolean; name?: string; count?: number; cracked?: number}> {
  try {
    const response = await fetch(`${config.serverUrl}/api/user.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        section: "hashlist",
        request: "getHashlist",
        accessKey: config.apiKey,
        hashlistId,
      }),
    });
    const data = await response.json();
    if (data.response === "OK") {
      return {
        exists: true,
        name: data.name,
        count: data.hashCount,
        cracked: data.cracked,
      };
    }
    return { exists: false };
  } catch {
    return { exists: false };
  }
}

function execSQL(config: ServerConfig, sql: string): string {
  const b64Sql = Buffer.from(sql).toString("base64");
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 ubuntu@${config.serverIp} "echo ${b64Sql} | base64 -d | sudo docker exec -i hashtopolis-db mysql -u hashtopolis -p'${config.dbPass}' hashtopolis -sN"`;
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

async function createTask(
  config: ServerConfig,
  params: {
    hashlistId: number;
    name: string;
    attackCmd: string;
    priority: number;
    isSmall: boolean;
  }
): Promise<{ taskId: number; wrapperId: number }> {
  // Use SSH + Docker exec since API createTask is broken in Hashtopolis 0.14.x
  // Match CrackSubmitter.ts schema exactly

  // 1. Create TaskWrapper (hashlistId goes here)
  const wrapperSQL = `INSERT INTO TaskWrapper (priority, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked, maxAgents) VALUES (${params.priority}, 0, ${params.hashlistId}, 1, '${params.name}', 0, 0, 0)`;
  execSQL(config, wrapperSQL);
  const wrapperId = parseInt(execSQL(config, "SELECT MAX(taskWrapperId) FROM TaskWrapper"));

  // 2. Create Task (NO hashlistId - it's in TaskWrapper)
  const taskSQL = `INSERT INTO Task (taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress, priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace, crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes, staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand) VALUES ('${params.name}', '${params.attackCmd}', 600, 5, 0, 0, ${params.priority}, 0, NULL, ${params.isSmall ? 1 : 0}, 0, 0, 0, 1, 1, ${wrapperId}, 0, '', 0, 0, 0, 0, '')`;
  execSQL(config, taskSQL);
  const taskId = parseInt(execSQL(config, "SELECT MAX(taskId) FROM Task"));

  return { taskId, wrapperId };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    console.log(`QuickAttack - One-off attacks on existing Hashtopolis hashlists

Usage:
  bun QuickAttack.ts --hashlist <id> --attack <name> [--priority <n>]
  bun QuickAttack.ts --hashlist <id> --list
  bun QuickAttack.ts --attacks

Options:
  --hashlist <id>   Hashtopolis hashlist ID
  --attack <name>   Attack preset (see --attacks)
  --priority <n>    Override default priority
  --dry-run         Preview without creating task
  --attacks         List available attack presets

Examples:
  bun QuickAttack.ts --hashlist 1575 --attack brute-1-4
  bun QuickAttack.ts --hashlist 1575 --attack brute-1-4 --priority 99
`);
    return;
  }

  if (args.includes("--attacks")) {
    console.log("Available Attacks:");
    console.log("==================\n");
    for (const [key, attack] of Object.entries(ATTACKS)) {
      console.log(`${key}:`);
      console.log(`  ${attack.description}`);
      console.log(`  Cmd: ${attack.cmd}`);
      console.log(`  Priority: ${attack.priority}`);
      console.log("");
    }
    return;
  }

  const hashlistIdx = args.indexOf("--hashlist");
  const attackIdx = args.indexOf("--attack");
  const priorityIdx = args.indexOf("--priority");
  const dryRun = args.includes("--dry-run");

  if (hashlistIdx === -1 || !args[hashlistIdx + 1]) {
    console.error("Error: --hashlist <id> is required");
    process.exit(1);
  }

  const hashlistId = parseInt(args[hashlistIdx + 1], 10);
  const config = getServerConfig();

  // Check if hashlist exists
  console.log(`Checking hashlist ${hashlistId}...`);
  const hashlistInfo = await getHashlistInfo(config, hashlistId);

  if (!hashlistInfo.exists) {
    console.error(`Error: Hashlist ${hashlistId} not found in Hashtopolis`);
    process.exit(1);
  }

  console.log(`Found: ${hashlistInfo.name}`);
  console.log(`  Hashes: ${hashlistInfo.count?.toLocaleString()}`);
  console.log(`  Cracked: ${hashlistInfo.cracked?.toLocaleString()} (${((hashlistInfo.cracked || 0) / (hashlistInfo.count || 1) * 100).toFixed(2)}%)`);

  if (args.includes("--list")) {
    return;
  }

  if (attackIdx === -1 || !args[attackIdx + 1]) {
    console.error("Error: --attack <name> is required");
    process.exit(1);
  }

  const attackName = args[attackIdx + 1];
  const attack = ATTACKS[attackName];

  if (!attack) {
    console.error(`Error: Unknown attack '${attackName}'`);
    console.error(`Available: ${Object.keys(ATTACKS).join(", ")}`);
    process.exit(1);
  }

  const priority = priorityIdx !== -1 ? parseInt(args[priorityIdx + 1], 10) : attack.priority;
  const taskName = `${hashlistInfo.name}-${attackName}`;

  console.log(`\nCreating task:`);
  console.log(`  Name: ${taskName}`);
  console.log(`  Attack: ${attack.cmd}`);
  console.log(`  Priority: ${priority}`);
  console.log(`  Small: ${attack.isSmall}`);

  if (dryRun) {
    console.log("\n[DRY RUN] Would create task");
    return;
  }

  const { taskId, wrapperId } = await createTask(config, {
    hashlistId,
    name: taskName,
    attackCmd: attack.cmd,
    priority,
    isSmall: attack.isSmall,
  });

  console.log(`\n✓ Created TaskWrapper ${wrapperId}, Task ${taskId}`);
  console.log(`  View: ${config.serverUrl}/tasks.php`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
