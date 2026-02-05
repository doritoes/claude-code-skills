#!/usr/bin/env bun
/**
 * WarmStart.ts - Post-Power-On Infrastructure Recovery
 *
 * Automates the warm start process after AWS instances are powered on:
 * 1. Refreshes terraform state to capture new public IPs
 * 2. Updates .claude/.env with the new server URL
 * 3. Validates SSH connectivity to server
 * 4. Checks Docker containers are running
 * 5. Verifies all agents are online
 *
 * USAGE:
 *   bun Tools/WarmStart.ts           # Full warm start with validation
 *   bun Tools/WarmStart.ts --check   # Check if warm start is needed
 *   bun Tools/WarmStart.ts --dry-run # Show what would be updated
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const HASHCRACK_DIR = resolve(SKILL_DIR, "..", "Hashcrack");
const CLAUDE_DIR = resolve(SKILL_DIR, "..", "..");
const ENV_FILE = resolve(CLAUDE_DIR, ".env");
const TERRAFORM_DIR = resolve(HASHCRACK_DIR, "terraform", "aws");

// Colors for terminal output
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

interface WarmStartResult {
  success: boolean;
  oldServerIp: string | null;
  newServerIp: string | null;
  envUpdated: boolean;
  terraformRefreshed: boolean;
  serverReachable: boolean;
  dockerHealthy: boolean;
  filesReady: boolean;
  agentsOnline: number;
  agentsTotal: number;
  errors: string[];
  warnings: string[];
}

// =============================================================================
// Helper Functions
// =============================================================================

function printBanner() {
  console.log(`
╭─────────────────────────────────────────────────────────────╮
│           WARMSTART - Post-Power-On Recovery                │
╰─────────────────────────────────────────────────────────────╯
`);
}

function getEnvServerIp(): string | null {
  if (!existsSync(ENV_FILE)) return null;

  const content = readFileSync(ENV_FILE, "utf-8");
  const match = content.match(/HASHCRACK_SERVER_URL=https?:\/\/([^:\/\s]+)/);
  return match ? match[1] : null;
}

function getTerraformServerIp(): string | null {
  try {
    const ip = execSync("terraform output -raw server_ip", {
      encoding: "utf-8",
      cwd: TERRAFORM_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000
    }).trim();
    return ip || null;
  } catch {
    return null;
  }
}

function getAwsInstanceIp(instanceId: string): string | null {
  try {
    // Use us-west-2 region where hashcrack infrastructure is deployed
    const result = execSync(
      `aws ec2 describe-instances --region us-west-2 --instance-ids ${instanceId} --query "Reservations[0].Instances[0].PublicIpAddress" --output text`,
      { encoding: "utf-8", timeout: 30000 }
    ).trim();
    return result && result !== "None" ? result : null;
  } catch {
    return null;
  }
}

function getServerInstanceId(): string | null {
  try {
    const id = execSync("terraform output -raw server_id", {
      encoding: "utf-8",
      cwd: TERRAFORM_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000
    }).trim();
    return id || null;
  } catch {
    return null;
  }
}

function refreshTerraform(): boolean {
  try {
    console.log(`${CYAN}[1/5]${RESET} Refreshing terraform state...`);
    execSync("terraform apply -refresh-only -auto-approve", {
      cwd: TERRAFORM_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000
    });
    console.log(`      ${GREEN}✓${RESET} Terraform state refreshed`);
    return true;
  } catch (e) {
    console.log(`      ${RED}✗${RESET} Terraform refresh failed: ${e}`);
    return false;
  }
}

function updateEnvFile(newIp: string): boolean {
  try {
    console.log(`${CYAN}[2/5]${RESET} Updating .claude/.env...`);

    if (!existsSync(ENV_FILE)) {
      console.log(`      ${RED}✗${RESET} .env file not found at ${ENV_FILE}`);
      return false;
    }

    let content = readFileSync(ENV_FILE, "utf-8");
    const oldUrlMatch = content.match(/HASHCRACK_SERVER_URL=https?:\/\/[^:\/\s]+:\d+/);

    if (oldUrlMatch) {
      const newUrl = `HASHCRACK_SERVER_URL=http://${newIp}:8080`;
      content = content.replace(/HASHCRACK_SERVER_URL=https?:\/\/[^:\/\s]+:\d+/, newUrl);
      writeFileSync(ENV_FILE, content);
      console.log(`      ${GREEN}✓${RESET} Updated HASHCRACK_SERVER_URL to http://${newIp}:8080`);
      return true;
    } else {
      console.log(`      ${YELLOW}⚠${RESET} HASHCRACK_SERVER_URL not found in .env`);
      return false;
    }
  } catch (e) {
    console.log(`      ${RED}✗${RESET} Failed to update .env: ${e}`);
    return false;
  }
}

function checkServerReachable(ip: string): boolean {
  try {
    console.log(`${CYAN}[3/5]${RESET} Testing SSH connectivity to ${ip}...`);
    const result = execSync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${ip} "hostname && uptime"`,
      { encoding: "utf-8", timeout: 20000 }
    );
    console.log(`      ${GREEN}✓${RESET} SSH connected: ${result.trim().split('\n')[0]}`);
    return true;
  } catch {
    console.log(`      ${RED}✗${RESET} SSH connection failed`);
    return false;
  }
}

function checkDockerHealth(ip: string): boolean {
  try {
    console.log(`${CYAN}[4/6]${RESET} Checking Docker containers...`);
    const result = execSync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${ip} "sudo docker ps --format '{{.Names}}:{{.Status}}'"`,
      { encoding: "utf-8", timeout: 20000 }
    );

    const containers = result.trim().split('\n').filter(l => l.length > 0);
    const required = ['hashtopolis-frontend', 'hashtopolis-backend', 'hashtopolis-db'];
    const running = containers.filter(c => c.includes('Up'));

    for (const name of required) {
      const found = running.some(c => c.startsWith(name));
      if (found) {
        console.log(`      ${GREEN}✓${RESET} ${name}: running`);
      } else {
        console.log(`      ${RED}✗${RESET} ${name}: NOT running`);
      }
    }

    return running.length >= 3;
  } catch (e) {
    console.log(`      ${RED}✗${RESET} Docker check failed: ${e}`);
    return false;
  }
}

/**
 * Copy attack files from Docker volume mount to expected location
 * LESSONS-LEARNED #30: Docker mounts files to /var/www/hashtopolis/files
 * but Hashtopolis StoredValue expects /usr/local/share/hashtopolis/files
 */
function copyAttackFiles(ip: string): boolean {
  try {
    console.log(`${CYAN}[5/6]${RESET} Copying attack files to expected location...`);
    console.log(`      (Docker mounts to /var/www, Hashtopolis expects /usr/local/share)`);

    // Copy files from Docker mount to expected location
    const copyCmd = `ssh -o StrictHostKeyChecking=no ubuntu@${ip} "sudo docker exec hashtopolis-backend bash -c 'cp /var/www/hashtopolis/files/* /usr/local/share/hashtopolis/files/ 2>/dev/null && ls -la /usr/local/share/hashtopolis/files/'"`;
    const result = execSync(copyCmd, { encoding: "utf-8", timeout: 60000 });

    // Verify rockyou.txt is present and correct size
    if (result.includes("rockyou.txt")) {
      const sizeMatch = result.match(/(\d+)\s+\w+\s+\d+\s+\d+:\d+\s+rockyou\.txt/);
      if (sizeMatch) {
        const size = parseInt(sizeMatch[1]);
        if (size > 100000000) { // ~139MB
          console.log(`      ${GREEN}✓${RESET} rockyou.txt: ${(size / 1024 / 1024).toFixed(1)}MB`);
        } else {
          console.log(`      ${YELLOW}⚠${RESET} rockyou.txt may be truncated (${size} bytes)`);
        }
      }
    }

    // Verify getFile endpoint works
    const token = execSync(
      `ssh -o StrictHostKeyChecking=no ubuntu@${ip} "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$(terraform output -raw db_password 2>/dev/null || echo '')' hashtopolis -sNe 'SELECT token FROM Agent LIMIT 1' 2>/dev/null || echo ''"`,
      { encoding: "utf-8", cwd: TERRAFORM_DIR, timeout: 30000 }
    ).trim();

    if (token) {
      const downloadTest = execSync(
        `ssh -o StrictHostKeyChecking=no ubuntu@${ip} "curl -s -w '%{size_download}' -o /dev/null 'http://localhost:8080/getFile.php?file=1&token=${token}'"`,
        { encoding: "utf-8", timeout: 60000 }
      ).trim();
      const downloadSize = parseInt(downloadTest);
      if (downloadSize > 100000000) {
        console.log(`      ${GREEN}✓${RESET} getFile endpoint working (${(downloadSize / 1024 / 1024).toFixed(1)}MB)`);
        return true;
      } else if (downloadSize < 100) {
        console.log(`      ${RED}✗${RESET} getFile returns error (${downloadSize} bytes - likely ERR3)`);
        return false;
      }
    }

    console.log(`      ${GREEN}✓${RESET} Files copied`);
    return true;
  } catch (e) {
    console.log(`      ${RED}✗${RESET} File copy failed: ${e}`);
    return false;
  }
}

function checkAgentStatus(ip: string, dbPassword: string): { online: number; total: number } {
  try {
    console.log(`${CYAN}[6/6]${RESET} Checking agent status...`);

    const sql = "SELECT agentId, agentName, TIMESTAMPDIFF(SECOND, lastTime, NOW()) as secAgo FROM Agent WHERE isActive=1 ORDER BY agentId";
    const result = execSync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 ubuntu@${ip} "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'${dbPassword}' hashtopolis -sNe \\"${sql}\\""`,
      { encoding: "utf-8", timeout: 30000 }
    );

    const lines = result.trim().split('\n').filter(l => l.length > 0);
    let online = 0;

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const name = parts[1];
        const secAgo = parseInt(parts[2], 10);
        const status = secAgo < 60 ? `${GREEN}online${RESET}` :
                       secAgo < 300 ? `${YELLOW}stale (${secAgo}s)${RESET}` :
                       `${RED}critical (${secAgo}s)${RESET}`;
        console.log(`      ${secAgo < 60 ? '✓' : '⚠'} ${name}: ${status}`);
        if (secAgo < 60) online++;
      }
    }

    return { online, total: lines.length };
  } catch (e) {
    console.log(`      ${RED}✗${RESET} Agent check failed: ${e}`);
    return { online: 0, total: 0 };
  }
}

function getDbPassword(): string | null {
  // Try .env first
  if (existsSync(ENV_FILE)) {
    const content = readFileSync(ENV_FILE, "utf-8");
    const match = content.match(/HASHCRACK_DB_PASSWORD=([^\s\n]+)/);
    if (match) return match[1];
  }

  // Try terraform
  try {
    return execSync("terraform output -raw db_password", {
      encoding: "utf-8",
      cwd: TERRAFORM_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000
    }).trim();
  } catch {
    return null;
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const dryRun = args.includes("--dry-run");

  printBanner();

  const result: WarmStartResult = {
    success: false,
    oldServerIp: null,
    newServerIp: null,
    envUpdated: false,
    terraformRefreshed: false,
    serverReachable: false,
    dockerHealthy: false,
    agentsOnline: 0,
    agentsTotal: 0,
    errors: [],
    warnings: []
  };

  // Get current state
  result.oldServerIp = getEnvServerIp();
  console.log(`Current .env server IP: ${result.oldServerIp || '(not set)'}`);

  // Get server instance ID and current AWS IP
  const instanceId = getServerInstanceId();
  if (!instanceId) {
    result.errors.push("Could not get server instance ID from terraform");
    console.log(`${RED}ERROR:${RESET} Cannot determine server instance ID`);
    console.log("       Run: cd .claude/skills/Hashcrack/terraform/aws && terraform init");
    process.exit(1);
  }

  console.log(`Server instance ID: ${instanceId}`);

  // Get current IP from AWS
  const awsIp = getAwsInstanceIp(instanceId);
  if (!awsIp) {
    result.errors.push("Could not get current IP from AWS - instance may be stopped");
    console.log(`${RED}ERROR:${RESET} Cannot get IP from AWS. Instance may be stopped.`);
    console.log("       Start instances via AWS console first.");
    process.exit(1);
  }

  result.newServerIp = awsIp;
  console.log(`Current AWS public IP: ${awsIp}`);

  // Check if update is needed
  if (result.oldServerIp === awsIp) {
    console.log(`\n${GREEN}✓${RESET} IPs match - no update needed`);

    if (checkOnly) {
      console.log("\nWarm start not required.");
      process.exit(0);
    }
  } else {
    console.log(`\n${YELLOW}⚠${RESET} IP mismatch detected: ${result.oldServerIp} → ${awsIp}`);

    if (checkOnly) {
      console.log("\nWarm start IS required. Run without --check to update.");
      process.exit(1);
    }
  }

  if (dryRun) {
    console.log("\n--- DRY RUN MODE ---");
    console.log(`Would refresh terraform state`);
    console.log(`Would update .env: HASHCRACK_SERVER_URL=http://${awsIp}:8080`);
    console.log(`Would validate connectivity to ${awsIp}`);
    process.exit(0);
  }

  console.log("");

  // Step 1: Refresh terraform
  result.terraformRefreshed = refreshTerraform();

  // Step 2: Update .env if IP changed
  if (result.oldServerIp !== awsIp) {
    result.envUpdated = updateEnvFile(awsIp);
  } else {
    console.log(`${CYAN}[2/6]${RESET} .env already up to date`);
    result.envUpdated = true;
  }

  // Step 3: Check server reachable
  result.serverReachable = checkServerReachable(awsIp);

  // Step 4: Check Docker
  if (result.serverReachable) {
    result.dockerHealthy = checkDockerHealth(awsIp);
  } else {
    console.log(`${CYAN}[4/6]${RESET} Skipping Docker check (server unreachable)`);
  }

  // Step 5: Copy attack files to expected location (LESSONS-LEARNED #30)
  if (result.serverReachable && result.dockerHealthy) {
    result.filesReady = copyAttackFiles(awsIp);
  } else {
    console.log(`${CYAN}[5/6]${RESET} Skipping file copy (prerequisites not met)`);
    result.filesReady = false;
  }

  // Step 6: Check agents
  const dbPassword = getDbPassword();
  if (result.serverReachable && result.dockerHealthy && dbPassword) {
    const agents = checkAgentStatus(awsIp, dbPassword);
    result.agentsOnline = agents.online;
    result.agentsTotal = agents.total;
  } else {
    console.log(`${CYAN}[6/6]${RESET} Skipping agent check (prerequisites not met)`);
  }

  // Summary
  console.log("\n" + "─".repeat(60));
  console.log("SUMMARY");
  console.log("─".repeat(60));

  result.success = result.terraformRefreshed &&
                   result.envUpdated &&
                   result.serverReachable &&
                   result.dockerHealthy &&
                   result.filesReady;

  const checkMark = (ok: boolean) => ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;

  console.log(`${checkMark(result.terraformRefreshed)} Terraform state refreshed`);
  console.log(`${checkMark(result.envUpdated)} .env file updated`);
  console.log(`${checkMark(result.serverReachable)} Server SSH reachable`);
  console.log(`${checkMark(result.dockerHealthy)} Docker containers healthy (3/3)`);
  console.log(`${checkMark(result.filesReady)} Attack files in expected location`);
  console.log(`${checkMark(result.agentsOnline === result.agentsTotal)} Agents online (${result.agentsOnline}/${result.agentsTotal})`);

  if (result.success) {
    console.log(`\n${GREEN}✓ Warm start complete!${RESET}`);
    console.log(`\nNext step: bun Tools/PipelineMonitor.ts --quick`);
  } else {
    console.log(`\n${RED}✗ Warm start incomplete - see errors above${RESET}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error(`${RED}Fatal error:${RESET}`, e);
  process.exit(1);
});
