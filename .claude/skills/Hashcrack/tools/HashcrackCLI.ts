#!/usr/bin/env bun
/**
 * HashcrackCLI.ts - Distributed Password Hash Cracking CLI
 *
 * Main orchestrator for the Hashcrack skill. Manages infrastructure deployment,
 * hash job submission, progress monitoring, and teardown.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { resolve, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { execSync, spawn } from "child_process";
import {
  HashtopolisClient,
  detectHashType,
  getHashTypeName,
  HASH_TYPES,
} from "./HashtopolisClient";

// =============================================================================
// Types and Interfaces
// =============================================================================

interface CLIConfig {
  paiDir: string;
  skillDir: string;
  terraformDir: string;
  ansibleDir: string;
  envPath: string;
}

interface DeployOptions {
  workers: number;
  serverCpus?: number;
  serverMemory?: number;
  workerCpus?: number;
  workerMemory?: number;
  skipTemplateCheck?: boolean;
}

const TEMPLATE_NAME = "Ubuntu 24.04 Cloud-Init (Hub)";

interface CrackOptions {
  input?: string;
  type?: string;
  strategy?: "quick" | "comprehensive" | "thorough";
  name?: string;
}

// =============================================================================
// Configuration
// =============================================================================

function getConfig(): CLIConfig {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const paiDir = process.env.PAI_DIR || resolve(home, "AI-Projects");
  const skillDir = resolve(paiDir, ".claude/skills/Hashcrack");

  return {
    paiDir,
    skillDir,
    terraformDir: resolve(skillDir, "terraform"),
    ansibleDir: resolve(skillDir, "ansible"),
    envPath: resolve(paiDir, ".claude/.env"),
  };
}

function loadEnv(): Record<string, string> {
  const config = getConfig();
  const env: Record<string, string> = {};

  if (existsSync(config.envPath)) {
    const content = readFileSync(config.envPath, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^=#]+)=(.*)$/);
      if (match) {
        env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }

  return env;
}

function saveToEnv(key: string, value: string): void {
  const config = getConfig();
  const content = existsSync(config.envPath)
    ? readFileSync(config.envPath, "utf-8")
    : "";

  // Check if key exists
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    // Update existing
    const updated = content.replace(regex, `${key}=${value}`);
    writeFileSync(config.envPath, updated);
  } else {
    // Append new
    appendFileSync(config.envPath, `\n${key}=${value}\n`);
  }
}

// =============================================================================
// CLI Error Handling
// =============================================================================

class CLIError extends Error {
  constructor(message: string, public exitCode: number = 1) {
    super(message);
    this.name = "CLIError";
  }
}

function printError(message: string): void {
  console.error(`\x1b[31mError:\x1b[0m ${message}`);
}

function printSuccess(message: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${message}`);
}

function printInfo(message: string): void {
  console.log(`\x1b[36mℹ\x1b[0m ${message}`);
}

function printWarning(message: string): void {
  console.log(`\x1b[33m⚠\x1b[0m ${message}`);
}

// =============================================================================
// Template Management
// =============================================================================

async function checkTemplateExists(env: Record<string, string>): Promise<boolean> {
  const xcpngHost = env.XCPNG_HOST || "192.168.99.209";
  const xcpngUser = env.XCPNG_USER || "root";

  try {
    const result = execSync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${xcpngUser}@${xcpngHost} "xe template-list name-label='${TEMPLATE_NAME}' --minimal"`,
      { encoding: "utf-8", timeout: 30000 }
    );
    return result.trim().length > 0;
  } catch {
    // Try XO API if SSH fails
    if (env.XO_HOST && env.XO_USER && env.XO_PASSWORD) {
      try {
        // Ensure XO_HOST has protocol
        let xoHost = env.XO_HOST;
        if (!xoHost.startsWith("http")) {
          xoHost = `https://${xoHost}`;
        }

        const auth = Buffer.from(`${env.XO_USER}:${env.XO_PASSWORD}`).toString("base64");
        const response = await fetch(`${xoHost}/api/`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${auth}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "vm.getAll",
            params: {},
            id: 1,
          }),
          // @ts-ignore - Bun supports this for self-signed certs
          tls: { rejectUnauthorized: false },
        });
        const data = await response.json() as { result?: Array<{ name_label: string; is_a_template: boolean }> };
        if (data.result) {
          return data.result.some(
            (vm) => vm.name_label === TEMPLATE_NAME && vm.is_a_template
          );
        }
      } catch {
        return false;
      }
    }
    return false;
  }
}

async function setup(): Promise<void> {
  const config = getConfig();
  const env = loadEnv();

  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║              HASHCRACK ENVIRONMENT SETUP                    ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  // Check prerequisites
  printInfo("Checking prerequisites...");

  // Check XO/XCP-ng credentials
  if (!env.XO_HOST && !env.XCPNG_HOST) {
    printError("No XO_HOST or XCPNG_HOST configured");
    console.log(`
Add to .claude/.env:
  XO_HOST=https://192.168.99.206
  XO_USER=admin
  XO_PASSWORD=<password>

  # Or for direct SSH access:
  XCPNG_HOST=192.168.99.209
  XCPNG_USER=root
`);
    throw new CLIError("Missing hypervisor credentials");
  }
  printSuccess("Hypervisor credentials found");

  // Check Terraform
  try {
    execSync("terraform version", { stdio: "pipe" });
    printSuccess("Terraform installed");
  } catch {
    try {
      execSync("tofu version", { stdio: "pipe" });
      printSuccess("OpenTofu installed");
    } catch {
      printWarning("Terraform/OpenTofu not found - install before deploying");
    }
  }

  // Check template
  printInfo(`Checking for template: ${TEMPLATE_NAME}`);
  const templateExists = await checkTemplateExists(env);

  if (templateExists) {
    printSuccess(`Template "${TEMPLATE_NAME}" exists`);
  } else {
    printWarning(`Template "${TEMPLATE_NAME}" not found`);
    console.log(`
Creating Ubuntu 24.04 cloud-init template...
`);

    // Run CreateTemplate.ts
    try {
      const createTemplateScript = resolve(config.skillDir, "tools/CreateTemplate.ts");
      execSync(`bun run "${createTemplateScript}"`, {
        stdio: "inherit",
        cwd: config.skillDir,
      });
      printSuccess("Template created successfully");
    } catch (error) {
      printError("Failed to create template automatically");
      console.log(`
Manual template creation required:

Option 1: Via Xen Orchestra UI
  1. Go to Import > VM
  2. Select "From URL"
  3. Enter: https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
  4. Name: ${TEMPLATE_NAME}
  5. Enable Cloud-init
  6. After import, right-click → Convert to template

Option 2: Via SSH to XCP-ng
  ssh root@${env.XCPNG_HOST || "192.168.99.209"}
  cd /var/opt && wget https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
  # Then import via XO UI
`);
      throw new CLIError("Template creation failed");
    }
  }

  console.log(`
╔════════════════════════════════════════════════════════════╗
║                   SETUP COMPLETE                            ║
╚════════════════════════════════════════════════════════════╝

Ready to deploy! Run:
  hashcrack deploy --workers 3
`);
}

// =============================================================================
// Infrastructure Commands
// =============================================================================

async function deploy(options: DeployOptions): Promise<void> {
  const config = getConfig();
  const env = loadEnv();

  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║           HASHCRACK INFRASTRUCTURE DEPLOYMENT              ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  // Check prerequisites
  printInfo("Checking prerequisites...");

  if (!env.XO_HOST || !env.XO_USER || !env.XO_PASSWORD) {
    throw new CLIError(
      "XenOrchestra credentials not configured.\n" +
        "Set XO_HOST, XO_USER, and XO_PASSWORD in .claude/.env"
    );
  }

  // Check template exists (unless skipped)
  if (!options.skipTemplateCheck) {
    printInfo(`Checking for template: ${TEMPLATE_NAME}`);
    const templateExists = await checkTemplateExists(env);

    if (!templateExists) {
      printWarning(`Template "${TEMPLATE_NAME}" not found`);
      printInfo("Running setup to create template...");

      try {
        await setup();
      } catch {
        throw new CLIError(
          `Template "${TEMPLATE_NAME}" required.\nRun 'hashcrack setup' first or create manually.`
        );
      }
    } else {
      printSuccess(`Template "${TEMPLATE_NAME}" found`);
    }
  }

  // Check Terraform
  try {
    execSync("terraform version", { stdio: "pipe" });
    printSuccess("Terraform found");
  } catch {
    try {
      execSync("tofu version", { stdio: "pipe" });
      printSuccess("OpenTofu found");
    } catch {
      throw new CLIError("Terraform or OpenTofu not found. Please install one.");
    }
  }

  // Initialize Terraform
  printInfo("Initializing Terraform...");
  execSync("terraform init", {
    cwd: config.terraformDir,
    stdio: "inherit",
  });

  // Create terraform.tfvars
  // XenOrchestra provider requires wss:// URL
  let xoUrl = env.XO_HOST || "";
  if (!xoUrl.startsWith("ws")) {
    xoUrl = xoUrl.replace(/^https?:\/\//, "");
    xoUrl = `wss://${xoUrl}`;
  }

  const tfvars = `
xo_url      = "${xoUrl}"
xo_username = "${env.XO_USER}"
xo_password = "${env.XO_PASSWORD}"
worker_count = ${options.workers}
server_cpus  = ${options.serverCpus || 2}
server_memory_gb = ${options.serverMemory || 4}
worker_cpus  = ${options.workerCpus || 4}
worker_memory_gb = ${options.workerMemory || 4}
ssh_public_key = "${env.SSH_PUBLIC_KEY || ""}"
`;

  writeFileSync(resolve(config.terraformDir, "terraform.tfvars"), tfvars);

  // Plan
  printInfo("Planning infrastructure...");
  execSync("terraform plan -out=tfplan", {
    cwd: config.terraformDir,
    stdio: "inherit",
  });

  // Apply
  printInfo(`Deploying ${options.workers} worker(s)...`);
  execSync("terraform apply tfplan", {
    cwd: config.terraformDir,
    stdio: "inherit",
  });

  // Get outputs
  const outputs = JSON.parse(
    execSync("terraform output -json", {
      cwd: config.terraformDir,
      encoding: "utf-8",
    })
  );

  const serverUrl = outputs.server_url?.value;
  const serverIp = outputs.server_ip?.value;
  const credentials = outputs.hashtopolis_credentials?.value;
  const voucherCode = outputs.voucher_code?.value;

  // Save to env
  if (serverUrl) saveToEnv("HASHCRACK_SERVER_URL", serverUrl);
  if (credentials?.password)
    saveToEnv("HASHCRACK_ADMIN_PASSWORD", credentials.password);
  if (voucherCode) saveToEnv("HASHCRACK_VOUCHER", voucherCode);

  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║                   DEPLOYMENT COMPLETE                       ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`
  Server URL:  ${serverUrl}
  Server IP:   ${serverIp}
  Workers:     ${options.workers}

  Credentials saved to .claude/.env

  Next steps:
  1. Wait 2-3 minutes for services to start
  2. Run: hashcrack status
  3. Submit a job: hashcrack crack --input hashes.txt --type ntlm
`);
}

async function scale(workers: number): Promise<void> {
  const config = getConfig();

  printInfo(`Scaling to ${workers} workers...`);

  // Update worker_count in tfvars
  const tfvarsPath = resolve(config.terraformDir, "terraform.tfvars");
  if (!existsSync(tfvarsPath)) {
    throw new CLIError("No deployment found. Run 'hashcrack deploy' first.");
  }

  let tfvars = readFileSync(tfvarsPath, "utf-8");
  tfvars = tfvars.replace(/worker_count\s*=\s*\d+/, `worker_count = ${workers}`);
  writeFileSync(tfvarsPath, tfvars);

  // Apply changes
  execSync("terraform apply -auto-approve", {
    cwd: config.terraformDir,
    stdio: "inherit",
  });

  printSuccess(`Scaled to ${workers} workers`);
}

async function teardown(): Promise<void> {
  const config = getConfig();

  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║              DESTROYING HASHCRACK INFRASTRUCTURE            ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  printWarning("This will destroy ALL hashcrack VMs and data!");

  // Destroy infrastructure
  execSync("terraform destroy -auto-approve", {
    cwd: config.terraformDir,
    stdio: "inherit",
  });

  // Clean up env vars
  const envPath = config.envPath;
  if (existsSync(envPath)) {
    let content = readFileSync(envPath, "utf-8");
    content = content.replace(/^HASHCRACK_.*$/gm, "");
    content = content.replace(/\n{3,}/g, "\n\n");
    writeFileSync(envPath, content);
  }

  printSuccess("Infrastructure destroyed");
}

// =============================================================================
// Cracking Commands
// =============================================================================

async function crack(options: CrackOptions): Promise<void> {
  const env = loadEnv();

  if (!env.HASHCRACK_SERVER_URL || !env.HASHCRACK_API_KEY) {
    throw new CLIError(
      "Hashtopolis not configured. Run 'hashcrack deploy' first or set credentials."
    );
  }

  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║                  SUBMITTING HASH JOB                        ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  // Read hashes
  let hashes: string[];
  if (options.input) {
    if (!existsSync(options.input)) {
      throw new CLIError(`File not found: ${options.input}`);
    }
    hashes = readFileSync(options.input, "utf-8")
      .split("\n")
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
  } else {
    // Read from stdin
    printInfo("Reading hashes from stdin (paste and press Ctrl+D when done)...");
    const stdin = readFileSync(0, "utf-8");
    hashes = stdin
      .split("\n")
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
  }

  if (hashes.length === 0) {
    throw new CLIError("No hashes provided");
  }

  printInfo(`Loaded ${hashes.length} hashes`);

  // Detect or use specified hash type
  let hashTypeId: number;
  if (options.type) {
    const typeLower = options.type.toLowerCase();
    if (typeLower in HASH_TYPES) {
      hashTypeId = HASH_TYPES[typeLower];
    } else {
      hashTypeId = parseInt(options.type);
      if (isNaN(hashTypeId)) {
        throw new CLIError(`Unknown hash type: ${options.type}`);
      }
    }
  } else {
    const detected = detectHashType(hashes[0]);
    if (detected === null) {
      throw new CLIError(
        "Could not auto-detect hash type. Use --type to specify."
      );
    }
    hashTypeId = detected;
    printInfo(`Auto-detected hash type: ${getHashTypeName(hashTypeId)} (${hashTypeId})`);
  }

  // Connect to Hashtopolis
  const client = new HashtopolisClient({
    serverUrl: env.HASHCRACK_SERVER_URL,
    apiKey: env.HASHCRACK_API_KEY,
  });

  // Test connection
  if (!(await client.testConnection())) {
    throw new CLIError("Cannot connect to Hashtopolis server");
  }
  printSuccess("Connected to Hashtopolis");

  // Create hashlist
  const jobName = options.name || `hashcrack-${Date.now()}`;
  printInfo(`Creating hashlist: ${jobName}`);

  const hashlistId = await client.createHashlist({
    name: jobName,
    hashTypeId,
    hashes,
  });
  printSuccess(`Hashlist created (ID: ${hashlistId})`);

  // Create attack tasks based on strategy
  const strategy = options.strategy || "comprehensive";
  const tasks = getAttackTasks(strategy, hashTypeId);

  printInfo(`Creating ${tasks.length} attack tasks (${strategy} strategy)...`);

  for (const task of tasks) {
    const taskId = await client.createTask({
      name: `${jobName} - ${task.name}`,
      hashlistId,
      attackCmd: task.cmd,
      priority: task.priority,
    });
    printSuccess(`Task created: ${task.name} (ID: ${taskId})`);
  }

  // Save job info
  saveToEnv("HASHCRACK_CURRENT_HASHLIST", hashlistId.toString());
  saveToEnv("HASHCRACK_CURRENT_JOB", jobName);

  console.log(`
╔════════════════════════════════════════════════════════════╗
║                    JOB SUBMITTED                            ║
╚════════════════════════════════════════════════════════════╝

  Job Name:    ${jobName}
  Hashlist ID: ${hashlistId}
  Hash Count:  ${hashes.length}
  Hash Type:   ${getHashTypeName(hashTypeId)} (${hashTypeId})
  Strategy:    ${strategy}
  Tasks:       ${tasks.length}

  Monitor progress: hashcrack status
  View results:     hashcrack results
`);
}

function getAttackTasks(
  strategy: string,
  hashTypeId: number
): Array<{ name: string; cmd: string; priority: number }> {
  const tasks: Array<{ name: string; cmd: string; priority: number }> = [];

  // Quick strategy - just rockyou
  tasks.push({
    name: "Wordlist - rockyou",
    cmd: "#HL# -a 0 rockyou.txt",
    priority: 100,
  });

  if (strategy === "quick") return tasks;

  // Comprehensive - add rules
  tasks.push({
    name: "Wordlist + Rules - best64",
    cmd: "#HL# -a 0 -r best64.rule rockyou.txt",
    priority: 90,
  });

  tasks.push({
    name: "Common Masks",
    cmd: "#HL# -a 3 ?u?l?l?l?l?l?d?d?d?d",
    priority: 80,
  });

  if (strategy === "comprehensive") return tasks;

  // Thorough - heavy rules and more masks
  tasks.push({
    name: "Heavy Rules - rockyou-30000",
    cmd: "#HL# -a 0 -r rockyou-30000.rule rockyou.txt",
    priority: 50,
  });

  tasks.push({
    name: "Heavy Rules - OneRule",
    cmd: "#HL# -a 0 -r OneRuleToRuleThemAll.rule rockyou.txt",
    priority: 40,
  });

  tasks.push({
    name: "Extended Masks",
    cmd: "#HL# -a 3 ?a?a?a?a?a?a?a?a",
    priority: 20,
  });

  return tasks;
}

async function status(): Promise<void> {
  const env = loadEnv();

  if (!env.HASHCRACK_SERVER_URL || !env.HASHCRACK_API_KEY) {
    throw new CLIError("Hashtopolis not configured");
  }

  const client = new HashtopolisClient({
    serverUrl: env.HASHCRACK_SERVER_URL,
    apiKey: env.HASHCRACK_API_KEY,
  });

  // Get agents
  const agents = await client.listAgents();
  const activeAgents = agents.filter((a) => a.isActive);

  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║                    HASHCRACK STATUS                         ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  console.log(`Server: ${env.HASHCRACK_SERVER_URL}`);
  console.log(`Workers: ${activeAgents.length}/${agents.length} active\n`);

  // List agents
  console.log("Workers:");
  for (const agent of agents) {
    const status = agent.isActive ? "\x1b[32m●\x1b[0m" : "\x1b[31m○\x1b[0m";
    console.log(`  ${status} ${agent.agentName} (${agent.lastIp})`);
  }

  // Get current job progress
  if (env.HASHCRACK_CURRENT_HASHLIST) {
    console.log("\nCurrent Job:");
    const progress = await client.getJobProgress(
      parseInt(env.HASHCRACK_CURRENT_HASHLIST)
    );
    console.log(`  Name: ${env.HASHCRACK_CURRENT_JOB || "Unknown"}`);
    console.log(`  Progress: ${progress.crackedHashes}/${progress.totalHashes} (${progress.percentCracked.toFixed(1)}%)`);
    console.log(`  Active Tasks: ${progress.activeTasks}`);
  }

  // List running tasks
  const tasks = await client.listTasks();
  const activeTasks = tasks.filter((t) => !t.isArchived);

  if (activeTasks.length > 0) {
    console.log("\nActive Tasks:");
    for (const task of activeTasks.slice(0, 5)) {
      const taskStatus = await client.getTaskStatus(task.taskId as number);
      const bar = progressBar(taskStatus.percentComplete, 20);
      console.log(
        `  ${task.name}: ${bar} ${taskStatus.percentComplete.toFixed(1)}%`
      );
    }
  }
}

function progressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

async function results(): Promise<void> {
  const env = loadEnv();
  const config = getConfig();

  if (!env.HASHCRACK_CURRENT_HASHLIST) {
    throw new CLIError("No active job. Run 'hashcrack crack' first.");
  }

  const client = new HashtopolisClient({
    serverUrl: env.HASHCRACK_SERVER_URL,
    apiKey: env.HASHCRACK_API_KEY,
  });

  const hashlistId = parseInt(env.HASHCRACK_CURRENT_HASHLIST);
  const cracked = await client.getCrackedHashes(hashlistId);

  if (cracked.length === 0) {
    printInfo("No passwords cracked yet");
    return;
  }

  // Save results to env file (base64 encoded)
  const resultsJson = JSON.stringify(cracked);
  const resultsB64 = Buffer.from(resultsJson).toString("base64");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  saveToEnv(`HASHCRACK_RESULTS_${timestamp}`, resultsB64);

  console.log(`
╔════════════════════════════════════════════════════════════╗
║                    RESULTS SAVED                            ║
╚════════════════════════════════════════════════════════════╝

  Cracked: ${cracked.length} passwords
  Saved to: .claude/.env (HASHCRACK_RESULTS_${timestamp})

  For security, passwords are NOT displayed here.
  Log in to Hashtopolis UI to view: ${env.HASHCRACK_SERVER_URL}
`);
}

async function server(): Promise<void> {
  const env = loadEnv();

  if (!env.HASHCRACK_SERVER_URL) {
    throw new CLIError("No server deployed. Run 'hashcrack deploy' first.");
  }

  console.log(`
╔════════════════════════════════════════════════════════════╗
║                  HASHTOPOLIS SERVER                         ║
╚════════════════════════════════════════════════════════════╝

  URL:      ${env.HASHCRACK_SERVER_URL}
  Username: ${env.HASHCRACK_ADMIN_USER || "hashcrack"}
  Password: (see .claude/.env HASHCRACK_ADMIN_PASSWORD)

  Open in browser to view results and manage jobs.
`);
}

// =============================================================================
// CLI Help
// =============================================================================

function printHelp(): void {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║               HASHCRACK - Distributed Hash Cracking         ║
╚════════════════════════════════════════════════════════════╝

USAGE:
  hashcrack <command> [options]

COMMANDS:
  setup               Check prerequisites and create Ubuntu template

  deploy              Deploy Hashtopolis infrastructure
    --workers N       Number of worker VMs (default: 2)
    --skip-template   Skip template check

  scale               Scale workers up/down
    --workers N       Target worker count

  crack               Submit hash job
    --input FILE      Path to hash file
    --type TYPE       Hash type (md5, ntlm, sha512crypt, etc.)
    --strategy STR    Attack strategy: quick|comprehensive|thorough
    --name NAME       Job name

  status              Show current status
  results             Save cracked results to .env
  server              Show server URL and credentials
  teardown            Destroy all infrastructure

EXAMPLES:
  hashcrack deploy --workers 5
  hashcrack crack --input hashes.txt --type ntlm
  cat hashes.txt | hashcrack crack --type sha512crypt
  hashcrack scale --workers 10
  hashcrack status
  hashcrack teardown

HASH TYPES:
  md5, sha1, sha256, sha512, sha512crypt, bcrypt,
  ntlm, lm, netntlmv2, kerberos-tgs, etc.

SECURITY:
  - Cracked passwords are NEVER displayed in terminal
  - Results are saved to .claude/.env (base64 encoded)
  - View actual passwords in Hashtopolis web UI
`);
}

// =============================================================================
// CLI Entry Point
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const command = args[0];
  const parseArg = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  try {
    switch (command) {
      case "setup":
        await setup();
        break;

      case "deploy":
        await deploy({
          workers: parseInt(parseArg("workers") || "2"),
          serverCpus: parseArg("server-cpus")
            ? parseInt(parseArg("server-cpus")!)
            : undefined,
          serverMemory: parseArg("server-memory")
            ? parseInt(parseArg("server-memory")!)
            : undefined,
          workerCpus: parseArg("worker-cpus")
            ? parseInt(parseArg("worker-cpus")!)
            : undefined,
          workerMemory: parseArg("worker-memory")
            ? parseInt(parseArg("worker-memory")!)
            : undefined,
          skipTemplateCheck: args.includes("--skip-template"),
        });
        break;

      case "scale":
        const workers = parseArg("workers");
        if (!workers) {
          throw new CLIError("Usage: hashcrack scale --workers N");
        }
        await scale(parseInt(workers));
        break;

      case "crack":
        await crack({
          input: parseArg("input"),
          type: parseArg("type"),
          strategy: parseArg("strategy") as "quick" | "comprehensive" | "thorough",
          name: parseArg("name"),
        });
        break;

      case "status":
        await status();
        break;

      case "results":
        await results();
        break;

      case "server":
        await server();
        break;

      case "teardown":
        await teardown();
        break;

      default:
        printError(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof CLIError) {
      printError(error.message);
      process.exit(error.exitCode);
    }
    throw error;
  }
}

main().catch((error) => {
  printError(error.message);
  process.exit(1);
});
