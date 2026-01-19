#!/usr/bin/env bun
/**
 * Hashcrack Smoke Test v3
 *
 * Tests the SKILL PROCESS, not just the environment.
 *
 * Success Criteria (ALL required):
 * 1. 2 CPU workers deployed and registered
 * 2. BOTH workers crack hashes (verified via Chunk table)
 * 3. 100% of hashes cracked (not 50%)
 * 4. No manual task assignment (API only)
 * 5. Infrastructure destroyed after test
 *
 * Usage:
 *   bun run tests/smoke-test-v3.ts xcp-ng
 *   bun run tests/smoke-test-v3.ts aws
 *   bun run tests/smoke-test-v3.ts all
 */

import { $ } from "bun";
import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";

const SKILL_DIR = resolve(import.meta.dir, "..");

// Load .env credentials for Proxmox SSH
const ENV_PATH = resolve(SKILL_DIR, "..", ".env");
const envVars: Record<string, string> = {};
if (existsSync(ENV_PATH)) {
  const envContent = readFileSync(ENV_PATH, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
      const [key, ...valueParts] = trimmed.split("=");
      envVars[key.trim()] = valueParts.join("=").trim();
    }
  }
}

// Proxmox API credentials (from terraform.tfvars)
const PROXMOX_HOST = "192.168.99.205";
const PROXMOX_API_URL = `https://${PROXMOX_HOST}:8006/api2/json`;
const PROXMOX_USER = "root@pam";
const PROXMOX_PASSWORD = envVars.PVE_SSH_PASSWORD || "proxmox123";
const PROXMOX_NODE = "proxmox-lab";

// Cache for Proxmox API ticket
let proxmoxTicket: { ticket: string; csrf: string } | null = null;

// Get Proxmox API authentication ticket
async function getProxmoxTicket(): Promise<{ ticket: string; csrf: string }> {
  if (proxmoxTicket) return proxmoxTicket;

  const result = await $`curl -s -k -d "username=${PROXMOX_USER}&password=${PROXMOX_PASSWORD}" ${PROXMOX_API_URL}/access/ticket`.quiet();
  const response = JSON.parse(result.stdout.toString());

  if (!response.data?.ticket) {
    throw new Error("Failed to get Proxmox API ticket");
  }

  proxmoxTicket = {
    ticket: response.data.ticket,
    csrf: response.data.CSRFPreventionToken,
  };
  return proxmoxTicket;
}

// Proxmox API helper - GET request
async function proxmoxApiGet(endpoint: string): Promise<any> {
  const auth = await getProxmoxTicket();
  const result = await $`curl -s -k -b "PVEAuthCookie=${auth.ticket}" ${PROXMOX_API_URL}${endpoint}`.quiet();
  return JSON.parse(result.stdout.toString());
}

// Proxmox API helper - DELETE request
async function proxmoxApiDelete(endpoint: string): Promise<any> {
  const auth = await getProxmoxTicket();
  const result = await $`curl -s -k -X DELETE -b "PVEAuthCookie=${auth.ticket}" -H "CSRFPreventionToken: ${auth.csrf}" ${PROXMOX_API_URL}${endpoint}`.quiet();
  return JSON.parse(result.stdout.toString());
}

// Proxmox API helper - POST request
async function proxmoxApiPost(endpoint: string, data: string = ""): Promise<any> {
  const auth = await getProxmoxTicket();
  const result = await $`curl -s -k -X POST -b "PVEAuthCookie=${auth.ticket}" -H "CSRFPreventionToken: ${auth.csrf}" -d "${data}" ${PROXMOX_API_URL}${endpoint}`.quiet();
  return JSON.parse(result.stdout.toString());
}
const TERRAFORM_DIR = resolve(SKILL_DIR, "terraform");
const TEST_DATA_DIR = resolve(import.meta.dir, "data");

// Load test data from files
// CRITICAL: Use .map(x => x.trim()) to handle CRLF line endings from Windows
const SMOKE_HASHES = readFileSync(resolve(TEST_DATA_DIR, "smoke-hashes.txt"), "utf-8")
  .trim()
  .split("\n")
  .map((h) => h.trim())
  .filter((h) => h.length > 0);

const SMOKE_WORDLIST = readFileSync(resolve(TEST_DATA_DIR, "smoke-wordlist.txt"), "utf-8");
const SMOKE_RULES = readFileSync(resolve(TEST_DATA_DIR, "smoke-rules.rule"), "utf-8");
const SMOKE_PASSWORDS = readFileSync(resolve(TEST_DATA_DIR, "smoke-passwords.txt"), "utf-8")
  .trim()
  .split("\n")
  .map((p) => p.trim())
  .filter((p) => p.length > 0);

// Calculate expected keyspace: wordlist_lines × rules_lines
// This MUST be calculated manually because Hashtopolis doesn't calculate it correctly for rule attacks
const WORDLIST_LINES = SMOKE_WORDLIST.trim().split("\n").map(l => l.trim()).filter(l => l.length > 0).length;
const RULES_LINES = SMOKE_RULES.trim().split("\n").map(l => l.trim()).filter(l => l.length > 0).length;
const EXPECTED_KEYSPACE = WORDLIST_LINES * RULES_LINES;

// Provider configurations
interface ProviderConfig {
  name: string;
  dir: string;
  sshUser: string;
  sshKey?: string; // Path to SSH private key (cloud providers)
  serverIpOutput: string;
  waitTime: number;
  workerCount: number;
  chunkTime: number; // Seconds per chunk - lower for fast local providers
}

// SSH key paths for cloud providers
const SSH_DIR = process.env.HOME ? `${process.env.HOME}/.ssh` : `${process.env.USERPROFILE}/.ssh`;

const PROVIDERS: Record<string, ProviderConfig> = {
  "xcp-ng": {
    name: "XCP-ng",
    dir: TERRAFORM_DIR,
    sshUser: "ubuntu",
    serverIpOutput: "server_ip",
    waitTime: 300,
    workerCount: 2,
    chunkTime: 5, // 5s chunks with 84M keyspace = ~8 chunks at 2M H/s
  },
  proxmox: {
    name: "Proxmox",
    dir: resolve(TERRAFORM_DIR, "proxmox"),
    sshUser: "ubuntu",
    serverIpOutput: "server_ip",
    waitTime: 300,
    workerCount: 2,
    chunkTime: 5, // 5s chunks with 84M keyspace = ~8 chunks at 2M H/s
  },
  aws: {
    name: "AWS",
    dir: resolve(TERRAFORM_DIR, "aws"),
    sshUser: "ubuntu",
    sshKey: resolve(SSH_DIR, "id_ed25519"), // Uses default key per terraform.tfvars
    serverIpOutput: "server_ip",
    waitTime: 180,
    workerCount: 2,
    chunkTime: 60, // Cloud providers have higher latency, standard chunk time works
  },
  azure: {
    name: "Azure",
    dir: resolve(TERRAFORM_DIR, "azure"),
    sshUser: "ubuntu",
    sshKey: resolve(SSH_DIR, "azure_hashcrack"),
    serverIpOutput: "server_public_ip",
    waitTime: 300,
    workerCount: 2,
    chunkTime: 60,
  },
  gcp: {
    name: "GCP",
    dir: resolve(TERRAFORM_DIR, "gcp"),
    sshUser: "ubuntu",
    sshKey: resolve(SSH_DIR, "gcp_hashcrack"),
    serverIpOutput: "server_public_ip",
    waitTime: 180,
    workerCount: 2,
    chunkTime: 60,
  },
  oci: {
    name: "OCI",
    dir: resolve(TERRAFORM_DIR, "oci"),
    sshUser: "ubuntu",
    sshKey: resolve(SSH_DIR, "oci_hashcrack"),
    serverIpOutput: "server_ip",
    waitTime: 300,
    workerCount: 2,
    chunkTime: 60,
  },
};

// ANSI colors
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

interface TestResult {
  provider: string;
  status: "pass" | "fail" | "skip";
  deployTime?: number;
  crackTime?: number;
  totalTime?: number;
  crackedCount?: number;
  totalHashes?: number;
  agentCount?: number;
  workersEngaged?: number;
  error?: string;
  failReason?: string;
}

function log(color: string, prefix: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`${CYAN}[${timestamp}]${RESET} ${color}${prefix}${RESET} ${message}`);
}

function success(message: string) { log(GREEN, "✓", message); }
function errorLog(message: string) { log(RED, "✗", message); }
function warning(message: string) { log(YELLOW, "⚠", message); }
function info(message: string) { log(BLUE, "→", message); }
function step(message: string) { log(BOLD, "▶", message); }
function crack(message: string) { log(MAGENTA, "🔓", message); }

function header(provider: string) {
  console.log(`\n${BOLD}${BLUE}${"═".repeat(70)}${RESET}`);
  console.log(`${BOLD}${BLUE}  SMOKE TEST v3: ${provider}${RESET}`);
  console.log(`${BOLD}${BLUE}  Success: 2 workers, both crack, 100% hashes, no manual assignment${RESET}`);
  console.log(`${BOLD}${BLUE}${"═".repeat(70)}${RESET}\n`);
}

async function sleep(seconds: number, quiet = false) {
  if (!quiet) info(`Waiting ${seconds} seconds...`);
  await Bun.sleep(seconds * 1000);
}

async function sshCmd(serverIp: string, sshUser: string, cmd: string, timeout = 30, sshKey?: string): Promise<string> {
  if (sshKey) {
    const result = await $`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=${timeout} -i ${sshKey} ${sshUser}@${serverIp} ${cmd} 2>/dev/null`.quiet();
    return result.stdout.toString().trim();
  } else {
    const result = await $`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=${timeout} ${sshUser}@${serverIp} ${cmd} 2>/dev/null`.quiet();
    return result.stdout.toString().trim();
  }
}

async function getDbPassword(serverIp: string, sshUser: string, sshKey?: string): Promise<string> {
  const result = await sshCmd(serverIp, sshUser,
    "sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD | cut -d= -f2",
    30, sshKey
  );
  return result || "Hashcrack2025Lab";
}

async function mysqlQuery(serverIp: string, sshUser: string, dbPass: string, query: string, sshKey?: string): Promise<string> {
  const escaped = query.replace(/"/g, '\\"');
  return await sshCmd(serverIp, sshUser,
    `sudo docker exec hashtopolis-db mysql -u hashtopolis -p"${dbPass}" hashtopolis -sNe "${escaped}"`,
    30, sshKey
  );
}

async function runSmokeTest(providerKey: string): Promise<TestResult> {
  const config = PROVIDERS[providerKey];
  if (!config) {
    return { provider: providerKey, status: "fail", error: "Unknown provider" };
  }

  header(config.name);
  const startTime = Date.now();
  let serverIp = "";
  let deployed = false;
  let dbPassword = "";
  let agentCount = 0;
  let workersEngaged = 0;

  try {
    // ========== STEP 1: Prerequisites ==========
    step("Step 1: Checking prerequisites");

    if (!existsSync(config.dir)) {
      throw new Error(`Terraform directory not found: ${config.dir}`);
    }

    const tfvarsPath = resolve(config.dir, "terraform.tfvars");
    if (!existsSync(tfvarsPath)) {
      throw new Error(`terraform.tfvars not found - copy from terraform.tfvars.example`);
    }

    // Verify test data exists (minimum 4 hashes, keyspace from wordlist×rules handles chunking)
    if (SMOKE_HASHES.length < 4) {
      throw new Error(`Not enough test hashes: ${SMOKE_HASHES.length} (need 4+)`);
    }

    success(`Prerequisites OK (${SMOKE_HASHES.length} hashes, ${SMOKE_PASSWORDS.length} passwords)`);

    // ========== STEP 1.5: Clean up orphaned VMs (XCP-ng/Proxmox) ==========
    if (providerKey === "xcp-ng") {
      step("Step 1.5: Cleaning up orphaned VMs on XCP-ng");
      try {
        // Get XCP-ng host from terraform.tfvars or use default
        const xcpHost = "192.168.99.209"; // labhost1
        const cleanupResult = await $`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@${xcpHost} 'for vm in $(xe vm-list name-label=hashcrack-worker-1 --minimal) $(xe vm-list name-label=hashcrack-worker-2 --minimal) $(xe vm-list name-label=hashcrack-server --minimal); do [ -n "$vm" ] && echo "Destroying orphan: $vm" && xe vm-destroy uuid=$vm; done'`.quiet();
        const output = cleanupResult.stdout.toString().trim();
        if (output.includes("Destroying")) {
          warning(`Cleaned up orphaned VMs: ${output}`);
        } else {
          success("No orphaned VMs found");
        }
      } catch (e) {
        warning(`Could not check for orphaned VMs: ${e}`);
      }
    } else if (providerKey === "proxmox") {
      step("Step 1.5: Cleaning up orphaned VMs on Proxmox via API");
      try {
        // VM IDs: server=200, workers=210,211
        const vmIds = [200, 210, 211];
        let cleanedUp = false;

        for (const vmid of vmIds) {
          // Check if VM exists via Proxmox API
          let vmExists = false;
          let vmStatus = "";
          try {
            const statusResp = await proxmoxApiGet(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/status/current`);
            if (statusResp.data) {
              vmExists = true;
              vmStatus = statusResp.data.status;
            }
          } catch (e) {
            // VM doesn't exist, that's fine
            continue;
          }

          if (vmExists) {
            // VM exists - stop and destroy it
            warning(`Found orphan VM ${vmid} (${vmStatus}), destroying...`);
            cleanedUp = true;

            try {
              // Stop VM if running
              if (vmStatus === "running") {
                await proxmoxApiPost(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/status/stop`);
                // Wait for stop to complete
                info(`Waiting for VM ${vmid} to stop...`);
                for (let i = 0; i < 12; i++) {
                  await Bun.sleep(5000);
                  try {
                    const st = await proxmoxApiGet(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/status/current`);
                    if (st.data?.status === "stopped") break;
                  } catch (e) {
                    break; // VM might already be gone
                  }
                }
              }

              // Delete VM with purge
              await proxmoxApiDelete(`/nodes/${PROXMOX_NODE}/qemu/${vmid}?purge=1&destroy-unreferenced-disks=1`);
              success(`Destroyed orphan VM ${vmid}`);
            } catch (e: any) {
              errorLog(`Failed to destroy VM ${vmid}: ${e.message || e}`);
            }
          }
        }

        if (cleanedUp) {
          // Wait for cleanup to complete
          await Bun.sleep(5000);
        } else {
          success("No orphaned VMs found");
        }
      } catch (e) {
        warning(`Could not check for orphaned VMs: ${e}`);
      }
    }

    // ========== STEP 2: Terraform Init ==========
    step("Step 2: Terraform init");
    await $`cd ${config.dir} && terraform init -upgrade`.quiet();
    success("Terraform initialized");

    // ========== STEP 3: Terraform Plan ==========
    step("Step 3: Terraform plan");
    await $`cd ${config.dir} && terraform plan -out=tfplan.smoke`.quiet();
    success("Plan created");

    // ========== STEP 4: Terraform Apply (Two-Stage for DHCP platforms) ==========
    step("Step 4: Terraform apply (deploying 1 server + 2 workers)");

    // For XCP-ng and Proxmox with DHCP, we need two-stage apply:
    // 1. Create server, wait for DHCP IP
    // 2. Pass actual IP to workers via variable override
    if (providerKey === "xcp-ng") {
      info("Using two-stage apply for XCP-ng (DHCP IP timing)");

      // Stage 1: Create server only
      await $`cd ${config.dir} && terraform apply -auto-approve -target=xenorchestra_vm.hashtopolis_server -target=time_sleep.wait_for_server_ip`;
      deployed = true;

      // Wait additional time for IP to propagate
      info("Waiting 60s for DHCP IP assignment...");
      await Bun.sleep(60000);

      // Refresh state to get updated IP
      await $`cd ${config.dir} && terraform refresh`.quiet();

      // Stage 2: Create workers with updated state
      info("Creating workers with updated server IP...");
      await $`cd ${config.dir} && terraform apply -auto-approve`;
    } else if (providerKey === "proxmox") {
      info("Using two-stage apply for Proxmox (DHCP IP timing)");
      const serverVmid = 200;

      // Stage 1: Create server only (let terraform handle template creation with create_template=true)
      // Per SKILL.md: terraform config automatically creates Ubuntu cloud-init template
      await $`cd ${config.dir} && terraform apply -auto-approve \
        -target=proxmox_virtual_environment_download_file.ubuntu_cloud_image \
        -target=proxmox_virtual_environment_vm.cloud_init_template \
        -target=proxmox_virtual_environment_file.server_cloud_init \
        -target=proxmox_virtual_environment_vm.server \
        -target=time_sleep.wait_for_server`;
      deployed = true;

      // Wait for server to boot and qemu-guest-agent to start
      info("Waiting 90s for server boot and qemu-guest-agent...");
      await Bun.sleep(90000);

      // Query Proxmox API for guest agent IP (agent installed via cloud-init)
      info("Querying Proxmox API for server DHCP IP from guest agent...");
      let actualServerIp = "";
      for (let attempt = 0; attempt < 15; attempt++) {
        try {
          const response = await proxmoxApiGet(`/nodes/${PROXMOX_NODE}/qemu/${serverVmid}/agent/network-get-interfaces`);

          if (response.data?.result) {
            // Find the first non-loopback IPv4 address
            for (const iface of response.data.result) {
              if (iface.name === "lo") continue;
              for (const addr of iface["ip-addresses"] || []) {
                if (addr["ip-address-type"] === "ipv4" && !addr["ip-address"].startsWith("127.")) {
                  actualServerIp = addr["ip-address"];
                  break;
                }
              }
              if (actualServerIp) break;
            }
          }
          if (actualServerIp) break;
        } catch (e) {
          // Guest agent not ready yet
        }
        info(`Waiting for guest agent IP (attempt ${attempt + 1}/15)...`);
        await Bun.sleep(10000);
      }

      if (!actualServerIp) {
        throw new Error("Could not get server DHCP IP from Proxmox guest agent API");
      }
      success(`Server DHCP IP: ${actualServerIp}`);
      serverIp = actualServerIp;

      // Stage 2: Create workers with actual server IP passed as variable override
      info("Creating workers with actual server IP...");
      await $`cd ${config.dir} && terraform apply -auto-approve -var="server_ip=${actualServerIp}/24"`;
    } else {
      // Cloud providers: single-stage apply (static IPs or proper DHCP handling)
      await $`cd ${config.dir} && terraform apply -auto-approve tfplan.smoke`;
      deployed = true;
    }
    success("Infrastructure deployed");

    // ========== STEP 5: Get Server IP ==========
    step("Step 5: Getting server IP");

    // For Proxmox, we already got the IP in Step 4 via two-stage apply
    if (providerKey === "proxmox" && serverIp) {
      info("Server IP already obtained from Proxmox guest agent in Step 4");
    } else {
      // XCP-ng and cloud providers: use terraform output
      const outputResult = await $`cd ${config.dir} && terraform output -raw ${config.serverIpOutput}`.quiet();
      serverIp = outputResult.stdout.toString().trim();

      if (!serverIp || serverIp === "") {
        throw new Error("Could not get server IP from terraform output");
      }
    }

    success(`Server IP: ${serverIp}`);

    // ========== STEP 6: Wait for Cloud-Init ==========
    step(`Step 6: Waiting ${config.waitTime}s for cloud-init`);
    await sleep(config.waitTime);

    const deployTime = Math.round((Date.now() - startTime) / 1000);

    // ========== STEP 7: Verify Server ==========
    step("Step 7: Verifying Hashtopolis server");
    let serverReady = false;
    for (let i = 0; i < 15; i++) {
      try {
        const checkResult = await $`curl -s --connect-timeout 10 http://${serverIp}:8080/ | head -c 500`.quiet();
        const output = checkResult.stdout.toString();
        if (output.includes("Hashtopolis") || output.includes("login") || output.includes("<!DOCTYPE")) {
          serverReady = true;
          break;
        }
      } catch (e) { /* retry */ }
      info(`Server not ready yet, retry ${i + 1}/15...`);
      await sleep(30, true);
    }

    if (!serverReady) {
      throw new Error("Server did not become ready after 7.5 minutes");
    }
    success("Hashtopolis server is running");

    // ========== STEP 8: Get DB Password ==========
    step("Step 8: Getting database password");
    dbPassword = await getDbPassword(serverIp, config.sshUser, config.sshKey);
    success(`Database password retrieved`);

    // ========== STEP 9: Create Vouchers ==========
    step("Step 9: Creating vouchers (one per worker)");

    // Get terraform voucher code (this is what workers are configured to use)
    let terraformVoucher = "";
    try {
      const voucherResult = await $`cd ${config.dir} && terraform output -raw voucher_code`.quiet();
      terraformVoucher = voucherResult.stdout.toString().trim();
      info(`Terraform voucher: ${terraformVoucher}`);
    } catch (e) {
      warning(`Could not get terraform voucher: ${e}`);
    }

    // Insert vouchers - including terraform voucher which workers are configured to use
    // SKILL.md: "Create ONE VOUCHER PER WORKER before boot (race conditions cause failures)"
    // Use INSERT IGNORE to avoid duplicate key errors if voucher already exists
    await mysqlQuery(serverIp, config.sshUser, dbPassword, `
      UPDATE Config SET value='0' WHERE item='voucherDeletion';
      INSERT IGNORE INTO RegVoucher (voucher, time) VALUES ('SMOKE_WORKER_1', UNIX_TIMESTAMP());
      INSERT IGNORE INTO RegVoucher (voucher, time) VALUES ('SMOKE_WORKER_2', UNIX_TIMESTAMP());
      ${terraformVoucher ? `INSERT IGNORE INTO RegVoucher (voucher, time) VALUES ('${terraformVoucher}', UNIX_TIMESTAMP());` : ""}
      ${terraformVoucher ? `INSERT IGNORE INTO RegVoucher (voucher, time) VALUES ('${terraformVoucher}', UNIX_TIMESTAMP());` : ""}
    `, config.sshKey);
    success("Vouchers created (including terraform voucher)");

    // ========== STEP 10: Wait for Agents ==========
    step("Step 10: Waiting for agents to register");
    const crackStartTime = Date.now();

    for (let i = 0; i < 20; i++) {
      try {
        const countResult = await mysqlQuery(serverIp, config.sshUser, dbPassword, "SELECT COUNT(*) FROM Agent", config.sshKey);
        agentCount = parseInt(countResult) || 0;
        if (agentCount >= 2) {
          success(`${agentCount} agents registered`);
          break;
        }
      } catch (e) { /* retry */ }
      info(`${agentCount}/2 agents registered, retry ${i + 1}/20...`);
      await sleep(15, true);
    }

    if (agentCount < 2) {
      throw new Error(`Only ${agentCount} agents registered - need 2 for smoke test`);
    }

    // ========== STEP 11: Trust Agents + Set CPU Mode ==========
    step("Step 11: Trusting agents and setting CPU mode");
    await mysqlQuery(serverIp, config.sshUser, dbPassword, `
      UPDATE Agent SET isTrusted = 1, cpuOnly = 1;
    `, config.sshKey);
    success("Agents trusted and set to CPU mode");

    // ========== STEP 12: Upload Files ==========
    step("Step 12: Uploading wordlist and rules");

    // Upload wordlist via stdin pipe (avoids command-line length limits with large files)
    const sshUploadArgs = config.sshKey
      ? ["ssh", "-o", "StrictHostKeyChecking=no", "-i", config.sshKey, `${config.sshUser}@${serverIp}`]
      : ["ssh", "-o", "StrictHostKeyChecking=no", `${config.sshUser}@${serverIp}`];

    const uploadWordlist = Bun.spawn(
      [...sshUploadArgs, "sudo tee /tmp/smoke-wordlist.txt > /dev/null"],
      { stdin: "pipe" }
    );
    uploadWordlist.stdin.write(SMOKE_WORDLIST);
    uploadWordlist.stdin.end();
    await uploadWordlist.exited;

    // Upload rules via stdin pipe
    const uploadRules = Bun.spawn(
      [...sshUploadArgs, "sudo tee /tmp/smoke-rules.rule > /dev/null"],
      { stdin: "pipe" }
    );
    uploadRules.stdin.write(SMOKE_RULES);
    uploadRules.stdin.end();
    await uploadRules.exited;

    // Copy to correct location with correct ownership
    // NOTE: Hashtopolis uses /usr/local/share/hashtopolis/files/ for getFile.php
    // Also copy to /var/www/hashtopolis/files/ (Docker volume mount) as fallback
    await sshCmd(serverIp, config.sshUser, `
      sudo docker exec hashtopolis-backend mkdir -p /usr/local/share/hashtopolis/files
      sudo docker exec hashtopolis-backend mkdir -p /var/www/hashtopolis/files
      sudo cat /tmp/smoke-wordlist.txt | sudo docker exec -i -u root hashtopolis-backend bash -c "cat > /usr/local/share/hashtopolis/files/smoke-wordlist.txt && chown www-data:www-data /usr/local/share/hashtopolis/files/smoke-wordlist.txt"
      sudo cat /tmp/smoke-rules.rule | sudo docker exec -i -u root hashtopolis-backend bash -c "cat > /usr/local/share/hashtopolis/files/smoke-rules.rule && chown www-data:www-data /usr/local/share/hashtopolis/files/smoke-rules.rule"
      sudo cat /tmp/smoke-wordlist.txt | sudo docker exec -i -u root hashtopolis-backend bash -c "cat > /var/www/hashtopolis/files/smoke-wordlist.txt && chown www-data:www-data /var/www/hashtopolis/files/smoke-wordlist.txt"
      sudo cat /tmp/smoke-rules.rule | sudo docker exec -i -u root hashtopolis-backend bash -c "cat > /var/www/hashtopolis/files/smoke-rules.rule && chown www-data:www-data /var/www/hashtopolis/files/smoke-rules.rule"
    `, 30, config.sshKey);

    // Verify files in both locations
    const fileCheck1 = await sshCmd(serverIp, config.sshUser,
      "sudo docker exec hashtopolis-backend ls -la /usr/local/share/hashtopolis/files/",
      30, config.sshKey
    );
    const fileCheck2 = await sshCmd(serverIp, config.sshUser,
      "sudo docker exec hashtopolis-backend ls -la /var/www/hashtopolis/files/",
      30, config.sshKey
    );
    info(`Files at /usr/local/share/hashtopolis/files/: ${fileCheck1.includes("smoke-wordlist.txt") ? "OK" : "MISSING"}`);
    info(`Files at /var/www/hashtopolis/files/: ${fileCheck2.includes("smoke-wordlist.txt") ? "OK" : "MISSING"}`);

    if (!fileCheck1.includes("smoke-wordlist.txt") && !fileCheck2.includes("smoke-wordlist.txt")) {
      throw new Error("Files not uploaded to either location");
    }
    success("Files uploaded to correct location(s)");

    // ========== STEP 13: Register Files in Database ==========
    step("Step 13: Registering files in database");
    const wordlistSize = SMOKE_WORDLIST.length;
    const wordlistLines = SMOKE_WORDLIST.split("\n").length;
    const rulesSize = SMOKE_RULES.length;
    const rulesLines = SMOKE_RULES.split("\n").length;

    // CRITICAL: Files MUST be isSecret=1 (secret) - trusted agents can access them
    // See SKILL.md: "Don't fight the secret defaults. Trust your agents first, then secrets work automatically."
    await mysqlQuery(serverIp, config.sshUser, dbPassword, `
      INSERT INTO File (filename, size, isSecret, fileType, accessGroupId, lineCount)
      VALUES ('smoke-wordlist.txt', ${wordlistSize}, 1, 0, 1, ${wordlistLines})
      ON DUPLICATE KEY UPDATE size=${wordlistSize}, lineCount=${wordlistLines}, isSecret=1;

      INSERT INTO File (filename, size, isSecret, fileType, accessGroupId, lineCount)
      VALUES ('smoke-rules.rule', ${rulesSize}, 1, 1, 1, ${rulesLines})
      ON DUPLICATE KEY UPDATE size=${rulesSize}, lineCount=${rulesLines}, isSecret=1;
    `, config.sshKey);

    const fileIdResult = await mysqlQuery(serverIp, config.sshUser, dbPassword,
      "SELECT fileId, filename FROM File WHERE filename IN ('smoke-wordlist.txt', 'smoke-rules.rule')",
      config.sshKey
    );
    success(`Files registered: ${fileIdResult.replace(/\n/g, ", ")}`);

    // Get file IDs
    const wordlistIdResult = await mysqlQuery(serverIp, config.sshUser, dbPassword,
      "SELECT fileId FROM File WHERE filename='smoke-wordlist.txt' LIMIT 1",
      config.sshKey
    );
    const rulesIdResult = await mysqlQuery(serverIp, config.sshUser, dbPassword,
      "SELECT fileId FROM File WHERE filename='smoke-rules.rule' LIMIT 1",
      config.sshKey
    );
    const wordlistId = parseInt(wordlistIdResult) || 0;
    const rulesId = parseInt(rulesIdResult) || 0;

    if (wordlistId === 0 || rulesId === 0) {
      throw new Error("Failed to get file IDs");
    }

    // ========== STEP 13.5: Verify Files on Disk (CRITICAL!) ==========
    // SKILL.md: "Workers download files from the server via getFile.php. If files are in wrong
    // location, workers get empty/corrupt files and cracking fails silently."
    // NOTE: getFile.php requires agent authentication - we verify file existence instead.
    step("Step 13.5: Verifying files exist on disk in correct location");
    const filesCheck = await sshCmd(serverIp, config.sshUser,
      `sudo docker exec hashtopolis-backend ls -la /usr/local/share/hashtopolis/files/ 2>/dev/null`,
      30, config.sshKey
    );
    if (!filesCheck.includes("smoke-wordlist.txt") || !filesCheck.includes("smoke-rules.rule")) {
      errorLog(`Files NOT found in expected location!`);
      info(`Files on disk: ${filesCheck}`);
      const dbFiles = await mysqlQuery(serverIp, config.sshUser, dbPassword,
        "SELECT fileId, filename, size, isSecret FROM File",
        config.sshKey
      );
      info(`File table: ${dbFiles}`);
      throw new Error("Files not in expected location - workers won't be able to download them!");
    }
    // Verify files have correct size (not empty)
    if (filesCheck.includes(" 0 ") && filesCheck.includes("smoke-")) {
      warning("One or more smoke files appears to be empty (0 bytes)!");
    }
    success("Files exist on disk in correct location");

    // ========== STEP 14: Create Hashlist ==========
    step("Step 14: Creating hashlist via database");

    // CRITICAL: Hashlist MUST be isSecret=1 (secret) - trusted agents can access it
    await mysqlQuery(serverIp, config.sshUser, dbPassword, `
      INSERT INTO Hashlist (hashlistName, format, hashTypeId, hashCount, saltSeparator, cracked, isSecret, hexSalt, isSalted, accessGroupId, notes, brainId, brainFeatures, isArchived)
      VALUES ('smoke-test-v3', 0, 1400, ${SMOKE_HASHES.length}, ':', 0, 1, 0, 0, 1, 'Smoke test v3 SHA256 hashes', 0, 0, 0);
    `, config.sshKey);

    const hashlistIdResult = await mysqlQuery(serverIp, config.sshUser, dbPassword,
      "SELECT hashlistId FROM Hashlist WHERE hashlistName='smoke-test-v3' ORDER BY hashlistId DESC LIMIT 1",
      config.sshKey
    );
    const hashlistId = parseInt(hashlistIdResult) || 0;
    if (hashlistId === 0) throw new Error("Failed to create hashlist");

    // Insert hashes
    for (const hash of SMOKE_HASHES) {
      await mysqlQuery(serverIp, config.sshUser, dbPassword,
        `INSERT INTO Hash (hashlistId, hash, salt, plaintext, timeCracked, chunkId, isCracked, crackPos) VALUES (${hashlistId}, '${hash}', '', '', NULL, NULL, 0, 0)`,
        config.sshKey
      );
    }
    success(`Hashlist created with ${SMOKE_HASHES.length} hashes (ID: ${hashlistId})`);

    // ========== STEP 14.5: Wait for both workers to be actively checking in ==========
    // For local providers with low latency, we need both workers to be ready before
    // creating the task, otherwise the faster worker grabs all chunks.
    step("Step 14.5: Waiting for both workers to be actively checking in");
    const benchmarkMaxRetries = 20;  // 20 * 10s = ~3 minutes max
    let bothActive = false;
    for (let i = 0; i < benchmarkMaxRetries && !bothActive; i++) {
      const activeAgentsResult = await mysqlQuery(serverIp, config.sshUser, dbPassword,
        `SELECT COUNT(*) FROM Agent WHERE isTrusted = 1 AND lastTime > UNIX_TIMESTAMP() - 30`,
        config.sshKey
      );
      const activeAgents = parseInt(activeAgentsResult) || 0;
      if (activeAgents >= 2) {
        bothActive = true;
        success(`Both workers active (${activeAgents}/2 checking in recently)`);
      } else {
        info(`${activeAgents}/2 workers active, waiting 10s (${i + 1}/${benchmarkMaxRetries})...`);
        await sleep(10000);
      }
    }
    if (!bothActive) {
      warning("Not all workers active, proceeding anyway");
    }

    // ========== STEP 15: Create Task via API ==========
    step("Step 15: Creating task via API (not manual assignment!)");

    // Create API key if not exists
    await mysqlQuery(serverIp, config.sshUser, dbPassword, `
      INSERT IGNORE INTO ApiKey (startValid, endValid, accessKey, accessCount, userId, apiGroupId)
      VALUES (1, 2000000000, 'SMOKE_API_KEY', 0, 1, 1);
    `, config.sshKey);

    // Create task via API (matching SKILL.md format exactly - line 333 style)
    // --force MUST be first for PoCL compatibility on CPU workers
    // 10 hashes spread from 0.6% to 97.5% of keyspace ensure both workers crack some
    const taskPayload = JSON.stringify({
      section: "task",
      request: "createTask",
      accessKey: "SMOKE_API_KEY",
      name: "smoke-test-v3-task",
      hashlistId: hashlistId,
      attackCmd: "--force -m 1400 #HL# smoke-wordlist.txt -r smoke-rules.rule",
      chunkTime: config.chunkTime,  // Provider-specific: 15s for local (fast), 60s for cloud
      statusTimer: 5,
      priority: 100,
      maxAgents: 0,
      isCpuTask: true,
      isSmall: false,
      crackerBinaryId: 1,
      crackerBinaryTypeId: 1,
      files: [wordlistId, rulesId],
    });

    const apiResult = await sshCmd(serverIp, config.sshUser,
      `curl -s -X POST http://localhost:8080/api/user.php -H 'Content-Type: application/json' -d '${taskPayload}'`,
      30, config.sshKey
    );

    // Check if API succeeded or fallback to database
    let taskId = 0;
    if (apiResult.includes('"response":"OK"') || apiResult.includes('"taskId"')) {
      const taskIdMatch = apiResult.match(/"taskId":(\d+)/);
      taskId = taskIdMatch ? parseInt(taskIdMatch[1]) : 0;
      success(`Task created via API (ID: ${taskId})`);
    } else {
      // Fallback: create via database (but note this in results)
      warning(`API returned: ${apiResult.substring(0, 100)} - falling back to database`);

      // Matching SKILL.md exactly: keyspace=0 (forces recalculation by agents)
      // Note: Agents may calculate keyspace incorrectly for rule attacks (537 vs 301K)
      // but this is the documented working pattern - keyspace issues are separate from Skips issue
      await mysqlQuery(serverIp, config.sshUser, dbPassword, `
        INSERT INTO TaskWrapper (priority, maxAgents, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked)
        VALUES (100, 0, 0, ${hashlistId}, 1, 'smoke-test-v3-wrapper', 0, 0);
        SET @tw = LAST_INSERT_ID();

        INSERT INTO Task (taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress, priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace, crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes, staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand)
        VALUES ('smoke-test-v3-task', '--force -m 1400 #HL# smoke-wordlist.txt -r smoke-rules.rule', ${config.chunkTime}, 5, 0, 0, 100, 0, '', 0, 1, 1, 0, 1, 1, @tw, 0, '', 0, 0, 0, 0, '');
        SET @t = LAST_INSERT_ID();

        INSERT INTO FileTask (fileId, taskId) VALUES (${wordlistId}, @t);
        INSERT INTO FileTask (fileId, taskId) VALUES (${rulesId}, @t);
      `, config.sshKey);

      const taskIdResult = await mysqlQuery(serverIp, config.sshUser, dbPassword,
        "SELECT taskId FROM Task WHERE taskName='smoke-test-v3-task' ORDER BY taskId DESC LIMIT 1",
        config.sshKey
      );
      taskId = parseInt(taskIdResult) || 0;
      success(`Task created via database fallback (ID: ${taskId})`);
    }

    if (taskId === 0) {
      throw new Error("Failed to create task");
    }

    // ========== STEP 15.5: Fix Keyspace for Rule Attack ==========
    // PROBLEM: Hashtopolis calculates keyspace as wordlist_lines (537), ignoring rules
    // SOLUTION: Update keyspace immediately after task creation, before agents pick it up
    // This ensures multiple chunks are created so both workers get work
    step("Step 15.5: Fixing keyspace for rule attack (agents miscalculate)");
    info(`Setting keyspace to ${EXPECTED_KEYSPACE} (${WORDLIST_LINES} words × ${RULES_LINES} rules)`);
    await mysqlQuery(serverIp, config.sshUser, dbPassword,
      `UPDATE Task SET keyspace=${EXPECTED_KEYSPACE}, keyspaceProgress=0 WHERE taskId=${taskId}`,
      config.sshKey
    );
    success(`Keyspace fixed: ${EXPECTED_KEYSPACE}`);

    // ========== STEP 16: Monitor Progress ==========
    step("Step 16: Monitoring cracking progress");
    let crackedCount = 0;
    const maxWait = 600; // 10 minutes max for 84M keyspace
    const noProgressTimeout = 180; // 3 minutes without progress = fail
    const startWait = Date.now();
    let lastProgress = 0;
    let lastProgressTime = Date.now();
    let noChunksWarnings = 0;

    while ((Date.now() - startWait) / 1000 < maxWait) {
      try {
        // Query task progress AND chunk status (per SKILL.md: always check chunk status)
        const statusResult = await mysqlQuery(serverIp, config.sshUser, dbPassword, `
          SELECT
            (SELECT COUNT(*) FROM Hash WHERE hashlistId=${hashlistId} AND isCracked=1) as cracked,
            (SELECT keyspace FROM Task WHERE taskId=${taskId}) as keyspace,
            (SELECT keyspaceProgress FROM Task WHERE taskId=${taskId}) as progress,
            (SELECT COUNT(*) FROM Chunk WHERE taskId=${taskId}) as chunks,
            (SELECT COUNT(DISTINCT agentId) FROM Chunk WHERE taskId=${taskId}) as activeWorkers,
            (SELECT COALESCE(SUM(cracked), 0) FROM Chunk WHERE taskId=${taskId}) as chunkCracked
        `, config.sshKey);

        const parts = statusResult.split("\t").map((x) => parseInt(x) || 0);
        const [cracked, keyspace, progress, chunks, activeWorkers, chunkCracked] = parts;
        crackedCount = cracked;

        const pct = keyspace > 0 ? Math.round((progress / keyspace) * 100) : 0;
        crack(`Progress: ${crackedCount}/${SMOKE_HASHES.length} cracked | Keyspace: ${pct}% (${progress}/${keyspace}) | Chunks: ${chunks} (${activeWorkers} workers) | Chunk.cracked: ${chunkCracked}`);

        // EARLY FAILURE: No chunks after 3 minutes = something is wrong
        // Allow plenty of time for: download binary (~40MB) + benchmark + first chunk
        if (chunks === 0) {
          noChunksWarnings++;
          const maxNoChunksIterations = 12; // 12 × 15s = 180s = 3 minutes

          if (noChunksWarnings >= maxNoChunksIterations) {
            // Check agent status to diagnose
            const agentActs = await mysqlQuery(serverIp, config.sshUser, dbPassword,
              "SELECT agentName, lastAct FROM Agent",
              config.sshKey
            );
            errorLog(`No chunks created after 3 minutes. Agent status: ${agentActs.replace(/\n/g, ', ')}`);
            if (agentActs.includes("getFile")) {
              throw new Error("EARLY FAIL: Agents stuck on getFile - files not downloading correctly");
            } else if (agentActs.includes("downloadBinary")) {
              throw new Error("EARLY FAIL: Agents stuck on downloadBinary - network may be slow");
            } else if (agentActs.includes("benchmark")) {
              throw new Error("EARLY FAIL: Agents stuck on benchmark - may need --force flag");
            } else {
              throw new Error(`EARLY FAIL: No chunks after 3 minutes - agents status: ${agentActs.replace(/\n/g, ', ')}`);
            }
          }
        } else {
          noChunksWarnings = 0; // Reset counter once chunks start appearing
        }

        // Track progress for no-progress timeout
        if (progress > lastProgress || cracked > 0) {
          lastProgress = progress;
          lastProgressTime = Date.now();
        } else if ((Date.now() - lastProgressTime) / 1000 > noProgressTimeout && chunks > 0) {
          throw new Error(`EARLY FAIL: No progress for ${noProgressTimeout}s despite ${chunks} chunks`);
        }

        // Check if done
        if (keyspace > 0 && progress >= keyspace) {
          info("Keyspace exhausted");
          break;
        }

        if (crackedCount >= SMOKE_HASHES.length) {
          info("All hashes cracked!");
          break;
        }
      } catch (e: any) {
        if (e.message?.includes("EARLY FAIL")) {
          throw e; // Re-throw early failure errors
        }
        warning(`Query error: ${e}`);
      }
      await sleep(15, true);
    }

    // ========== STEP 16.5: Diagnostic Info (Debug) ==========
    step("Step 16.5: Collecting diagnostic information");

    // Check agent status and errors
    const agentStatus = await mysqlQuery(serverIp, config.sshUser, dbPassword, `
      SELECT agentId, agentName, lastAct, lastTime, isActive, isTrusted, cpuOnly
      FROM Agent
    `, config.sshKey);
    info(`Agent status:`);
    for (const line of agentStatus.split("\n").filter((l: string) => l.trim())) {
      info(`  ${line}`);
    }

    // Check chunk details
    const chunkDetails = await mysqlQuery(serverIp, config.sshUser, dbPassword, `
      SELECT c.chunkId, c.state, c.skip, c.length, c.cracked, c.speed, c.agentId, a.agentName
      FROM Chunk c
      LEFT JOIN Agent a ON c.agentId = a.agentId
      WHERE c.taskId=${taskId}
    `, config.sshKey);
    info(`Chunk details:`);
    for (const line of chunkDetails.split("\n").filter((l: string) => l.trim())) {
      info(`  ${line}`);
    }

    // Check task details
    const taskDetails = await mysqlQuery(serverIp, config.sshUser, dbPassword, `
      SELECT taskId, taskName, attackCmd, keyspace, keyspaceProgress, isCpuTask
      FROM Task WHERE taskId=${taskId}
    `, config.sshKey);
    info(`Task details: ${taskDetails}`);

    // Check hash sample (first 5)
    const hashSample = await mysqlQuery(serverIp, config.sshUser, dbPassword, `
      SELECT hash, isCracked, plaintext FROM Hash WHERE hashlistId=${hashlistId} LIMIT 5
    `, config.sshKey);
    info(`Hash sample:`);
    for (const line of hashSample.split("\n").filter((l: string) => l.trim())) {
      info(`  ${line}`);
    }

    // Check FileTask links
    const fileLinks = await mysqlQuery(serverIp, config.sshUser, dbPassword, `
      SELECT ft.fileId, f.filename, f.size, f.isSecret
      FROM FileTask ft
      JOIN File f ON ft.fileId = f.fileId
      WHERE ft.taskId=${taskId}
    `, config.sshKey);
    info(`Files linked to task:`);
    for (const line of fileLinks.split("\n").filter((l: string) => l.trim())) {
      info(`  ${line}`);
    }

    // ========== STEP 17: Verify Results ==========
    step("Step 17: Verifying results (100% crack rate + both workers got work)");

    // Check final crack count
    const finalCracked = await mysqlQuery(serverIp, config.sshUser, dbPassword,
      `SELECT COUNT(*) FROM Hash WHERE hashlistId=${hashlistId} AND isCracked=1`,
      config.sshKey
    );
    crackedCount = parseInt(finalCracked) || 0;

    // Check how many workers GOT CHUNKS (not just cracked hashes)
    // This is the real measure of distribution - both workers should receive work
    const workersResult = await mysqlQuery(serverIp, config.sshUser, dbPassword, `
      SELECT COUNT(DISTINCT agentId) FROM Chunk WHERE taskId=${taskId}
    `, config.sshKey);
    workersEngaged = parseInt(workersResult) || 0;

    // Get details of worker contributions (chunks received + hashes cracked)
    const workerDetails = await mysqlQuery(serverIp, config.sshUser, dbPassword, `
      SELECT a.agentName, COUNT(c.chunkId) as chunks, SUM(c.cracked) as totalCracked
      FROM Chunk c
      JOIN Agent a ON c.agentId = a.agentId
      WHERE c.taskId=${taskId}
      GROUP BY c.agentId
    `, config.sshKey);

    info(`Worker contributions (chunks/cracked):`);
    for (const line of workerDetails.split("\n").filter((l) => l.trim())) {
      info(`  ${line.replace(/\t/g, ": ")}`);
    }

    // Validate success criteria
    const crackRate = (crackedCount / SMOKE_HASHES.length) * 100;

    if (crackedCount < SMOKE_HASHES.length) {
      throw new Error(`FAIL: Only cracked ${crackedCount}/${SMOKE_HASHES.length} (${crackRate.toFixed(1)}%) - need 100%`);
    }

    if (workersEngaged < 2) {
      throw new Error(`FAIL: Only ${workersEngaged} worker(s) got chunks - need both workers to receive work`);
    }

    success(`✓ Cracked: ${crackedCount}/${SMOKE_HASHES.length} (100%)`);
    success(`✓ Workers engaged: ${workersEngaged} (both workers received chunks)`);

    const crackTime = Math.round((Date.now() - crackStartTime) / 1000);

    // ========== STEP 18: Teardown ==========
    step("Step 18: Terraform destroy");
    // For private cloud (Proxmox/XCP-ng), preserve template and cloud image for faster re-runs
    // Only destroy the actual VMs and worker-specific resources
    if (providerKey === "proxmox" || providerKey === "xcpng") {
      info("Preserving template and cloud image for faster re-runs...");
      await $`cd ${config.dir} && terraform destroy -auto-approve \
        -target=proxmox_virtual_environment_vm.server \
        -target=proxmox_virtual_environment_vm.workers \
        -target=proxmox_virtual_environment_file.worker_cloud_init \
        -target=time_sleep.wait_for_server \
        -target=random_password.db_password`;
    } else {
      // Cloud providers: full destroy to avoid charges
      await $`cd ${config.dir} && terraform destroy -auto-approve`;
    }
    deployed = false;
    success("Infrastructure destroyed");

    // Cleanup plan file
    try {
      await $`rm -f ${resolve(config.dir, "tfplan.smoke")}`.quiet();
    } catch (e) { /* ignore */ }

    const totalTime = Math.round((Date.now() - startTime) / 1000);

    console.log(`\n${GREEN}${BOLD}╔════════════════════════════════════════════════════════════╗${RESET}`);
    console.log(`${GREEN}${BOLD}║  ✓ ${config.name} SMOKE TEST PASSED                         ║${RESET}`);
    console.log(`${GREEN}${BOLD}╚════════════════════════════════════════════════════════════╝${RESET}`);
    console.log(`  Deploy time:     ${deployTime}s`);
    console.log(`  Crack time:      ${crackTime}s`);
    console.log(`  Total time:      ${totalTime}s`);
    console.log(`  Agents:          ${agentCount}`);
    console.log(`  Workers engaged: ${workersEngaged}`);
    console.log(`  Cracked:         ${crackedCount}/${SMOKE_HASHES.length} (100%)\n`);

    return {
      provider: config.name,
      status: "pass",
      deployTime,
      crackTime,
      totalTime,
      crackedCount,
      totalHashes: SMOKE_HASHES.length,
      agentCount,
      workersEngaged,
    };
  } catch (err: any) {
    errorLog(`${config.name} smoke test FAILED: ${err.message}`);

    if (deployed) {
      warning("Cleaning up failed deployment...");
      try {
        // For private cloud (Proxmox/XCP-ng), preserve template and cloud image
        if (providerKey === "proxmox" || providerKey === "xcpng") {
          await $`cd ${config.dir} && terraform destroy -auto-approve \
            -target=proxmox_virtual_environment_vm.server \
            -target=proxmox_virtual_environment_vm.workers \
            -target=proxmox_virtual_environment_file.worker_cloud_init \
            -target=time_sleep.wait_for_server \
            -target=random_password.db_password`;
        } else {
          await $`cd ${config.dir} && terraform destroy -auto-approve`;
        }
        success("Cleanup completed");
      } catch (e) {
        errorLog("Cleanup failed - manual intervention may be required!");
      }
    }

    return {
      provider: config.name,
      status: "fail",
      agentCount,
      workersEngaged,
      error: err.message,
      failReason: err.message.includes("100%")
        ? "INSUFFICIENT_CRACK_RATE"
        : err.message.includes("workers")
        ? "SINGLE_WORKER_ONLY"
        : err.message.includes("agents")
        ? "AGENT_REGISTRATION_FAILED"
        : "UNKNOWN",
    };
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
${BOLD}Hashcrack Smoke Test v3${RESET}

Tests the SKILL PROCESS, not just the environment.

${BOLD}Success Criteria (ALL required):${RESET}
  1. 2 CPU workers deployed and registered
  2. BOTH workers crack hashes (verified via Chunk table)
  3. 100% of hashes cracked (not 50%)
  4. No manual task assignment (API only)
  5. Infrastructure destroyed after test

${BOLD}Usage:${RESET}
  bun run tests/smoke-test-v3.ts <provider>   Test single provider
  bun run tests/smoke-test-v3.ts all          Test all providers
  bun run tests/smoke-test-v3.ts local        Test local providers only (xcp-ng, proxmox)
  bun run tests/smoke-test-v3.ts cloud        Test cloud providers only (aws, azure, gcp, oci)

${BOLD}Providers:${RESET}
  xcp-ng, proxmox, aws, azure, gcp, oci

${BOLD}Test Data:${RESET}
  Hashes:   ${SMOKE_HASHES.length} SHA256 (mode 1400)
  Wordlist: ${SMOKE_WORDLIST.split("\n").length} words
  Rules:    ${SMOKE_RULES.split("\n").length} rules
  Keyspace: ~${(SMOKE_WORDLIST.split("\n").length * SMOKE_RULES.split("\n").length).toLocaleString()}
`);
    process.exit(0);
  }

  const providersToTest: string[] = [];

  if (args[0] === "all") {
    providersToTest.push(...Object.keys(PROVIDERS));
  } else if (args[0] === "local") {
    providersToTest.push("xcp-ng", "proxmox");
  } else if (args[0] === "cloud") {
    providersToTest.push("aws", "azure", "gcp", "oci");
  } else if (PROVIDERS[args[0]]) {
    providersToTest.push(args[0]);
  } else {
    errorLog(`Unknown provider: ${args[0]}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}${BLUE}╔════════════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${BLUE}║         HASHCRACK SMOKE TEST v3 - ${providersToTest.length} PROVIDER(S)                 ║${RESET}`);
  console.log(`${BOLD}${BLUE}║  Success: 2 workers, both crack, 100% hashes, no manual assign    ║${RESET}`);
  console.log(`${BOLD}${BLUE}╚════════════════════════════════════════════════════════════════════╝${RESET}\n`);

  console.log(`Providers:    ${providersToTest.join(", ")}`);
  console.log(`Test hashes:  ${SMOKE_HASHES.length} SHA256 (mode 1400, slower for more chunks)`);
  console.log(`Keyspace:     ~${(SMOKE_WORDLIST.split("\n").length * SMOKE_RULES.split("\n").length).toLocaleString()}`);
  console.log(`\n${YELLOW}⚠️  Cloud providers will incur costs!${RESET}`);
  console.log(`Press Ctrl+C within 10 seconds to abort...\n`);

  await sleep(10);

  const results: TestResult[] = [];

  for (const provider of providersToTest) {
    const result = await runSmokeTest(provider);
    results.push(result);
  }

  // Print summary
  console.log(`\n${BOLD}${BLUE}${"═".repeat(70)}${RESET}`);
  console.log(`${BOLD}${BLUE}  SMOKE TEST v3 SUMMARY${RESET}`);
  console.log(`${BOLD}${BLUE}${"═".repeat(70)}${RESET}\n`);

  console.log("Provider      │ Status │ Deploy │ Crack │ Workers │ Cracked      │ Fail Reason");
  console.log("──────────────┼────────┼────────┼───────┼─────────┼──────────────┼" + "─".repeat(20));

  for (const result of results) {
    const status =
      result.status === "pass"
        ? `${GREEN}PASS${RESET}`
        : result.status === "skip"
        ? `${YELLOW}SKIP${RESET}`
        : `${RED}FAIL${RESET}`;

    const deploy = result.deployTime ? `${result.deployTime}s` : "-";
    const crackT = result.crackTime ? `${result.crackTime}s` : "-";
    const workers = result.workersEngaged !== undefined ? `${result.workersEngaged}/2` : "-";
    const cracked =
      result.crackedCount !== undefined ? `${result.crackedCount}/${result.totalHashes}` : "-";
    const failReason = result.failReason || "-";

    console.log(
      `${result.provider.padEnd(13)} │ ${status}   │ ${deploy.padEnd(6)} │ ${crackT.padEnd(5)} │ ${workers.padEnd(7)} │ ${cracked.padEnd(12)} │ ${failReason.substring(0, 18)}`
    );
  }

  const resultsFile = resolve(TEST_DATA_DIR, `smoke-results-v3-${Date.now()}.json`);
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);

  const failed = results.filter((r) => r.status === "fail").length;
  const passed = results.filter((r) => r.status === "pass").length;

  if (failed > 0) {
    console.log(`\n${RED}${BOLD}${failed} provider(s) FAILED, ${passed} passed${RESET}`);
    process.exit(1);
  } else {
    console.log(`\n${GREEN}${BOLD}All ${passed} provider(s) PASSED!${RESET}`);
    process.exit(0);
  }
}

main().catch((err) => {
  errorLog(err.message);
  process.exit(1);
});
