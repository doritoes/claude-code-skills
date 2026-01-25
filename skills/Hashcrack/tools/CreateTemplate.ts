#!/usr/bin/env bun
/**
 * CreateTemplate.ts - Create Ubuntu 24.04 Cloud-Init Template on XCP-ng
 *
 * Checks if the required template exists and creates it if missing.
 * Uses XenOrchestra API or SSH to XCP-ng host.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { resolve } from "path";
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";

// =============================================================================
// Configuration
// =============================================================================

const TEMPLATE_NAME = "Ubuntu 24.04 Cloud-Init (Hub)";
const UBUNTU_IMAGE_URL =
  "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img";
const TEMPLATE_DESCRIPTION = "Ubuntu 24.04 LTS with cloud-init - PAI Hashcrack";

interface Config {
  xoHost: string;
  xoUser: string;
  xoPassword: string;
  xcpngHost: string;
  xcpngUser: string;
  srName: string;
}

// =============================================================================
// Environment Loading
// =============================================================================

function loadEnv(): Record<string, string> {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const envPath = resolve(home, "AI-Projects/.claude/.env");
  const env: Record<string, string> = {};

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^=#]+)=(.*)$/);
      if (match) {
        env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }

  return env;
}

function getConfig(): Config {
  const env = loadEnv();

  // Ensure XO_HOST has protocol
  let xoHost = env.XO_HOST || "192.168.99.206";
  if (xoHost && !xoHost.startsWith("http")) {
    xoHost = `https://${xoHost}`;
  }

  return {
    xoHost,
    xoUser: env.XO_USER || "admin",
    xoPassword: env.XO_PASSWORD || "",
    xcpngHost: env.XCPNG_HOST || "192.168.99.209",
    xcpngUser: env.XCPNG_USER || "root",
    srName: env.XCPNG_SR_NAME || "Local storage",
  };
}

// =============================================================================
// Output Helpers
// =============================================================================

function printInfo(msg: string): void {
  console.log(`\x1b[36mℹ\x1b[0m ${msg}`);
}

function printSuccess(msg: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}

function printWarning(msg: string): void {
  console.log(`\x1b[33m⚠\x1b[0m ${msg}`);
}

function printError(msg: string): void {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
}

// =============================================================================
// XenOrchestra API
// =============================================================================

async function xoApiCall(
  config: Config,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const auth = Buffer.from(`${config.xoUser}:${config.xoPassword}`).toString(
    "base64"
  );

  const response = await fetch(`${config.xoHost}/api/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id: 1,
    }),
  });

  const data = (await response.json()) as {
    result?: unknown;
    error?: { message: string };
  };
  if (data.error) {
    throw new Error(`XO API error: ${data.error.message}`);
  }

  return data.result;
}

async function checkTemplateExistsXO(config: Config): Promise<boolean> {
  try {
    const vms = (await xoApiCall(config, "vm.getAll")) as Array<{
      name_label: string;
      is_a_template: boolean;
    }>;

    const template = vms.find(
      (vm) => vm.name_label === TEMPLATE_NAME && vm.is_a_template
    );

    return !!template;
  } catch (error) {
    printWarning(`XO API check failed: ${(error as Error).message}`);
    return false;
  }
}

// =============================================================================
// SSH/xe CLI Methods
// =============================================================================

function sshCommand(config: Config, command: string, timeoutMs: number = 60000): string {
  const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${config.xcpngUser}@${config.xcpngHost} "${command}"`;

  try {
    return execSync(sshCmd, { encoding: "utf-8", timeout: timeoutMs });
  } catch (error) {
    throw new Error(`SSH command failed: ${(error as Error).message}`);
  }
}

function checkTemplateExistsSSH(config: Config): boolean {
  try {
    const result = sshCommand(
      config,
      `xe template-list name-label="${TEMPLATE_NAME}" --minimal`
    );
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

function getStorageRepositoryUUID(config: Config): string {
  const result = sshCommand(
    config,
    `xe sr-list name-label="${config.srName}" --minimal`
  );
  const uuid = result.trim();

  if (!uuid) {
    throw new Error(`Storage repository not found: ${config.srName}`);
  }

  return uuid;
}

// =============================================================================
// Template Creation
// =============================================================================

async function createTemplateViaSSH(config: Config): Promise<void> {
  printInfo("Creating Ubuntu 24.04 cloud-init template via SSH...");

  // Step 1: Check if image already exists or download it
  printInfo("Checking for Ubuntu cloud image...");

  const imageCheck = sshCommand(
    config,
    `[ -f /var/opt/templates/noble-server-cloudimg-amd64.img ] && echo "exists" || echo "missing"`
  ).trim();

  if (imageCheck === "missing") {
    printInfo("Downloading Ubuntu cloud image (~600MB)...");
    printInfo("Starting background download on XCP-ng host...");

    // Start download in background
    sshCommand(
      config,
      `mkdir -p /var/opt/templates && cd /var/opt/templates && nohup wget -q "${UBUNTU_IMAGE_URL}" > /var/opt/templates/download.log 2>&1 &`
    );

    // Wait for download to complete (check every 30 seconds)
    printInfo("Waiting for download to complete (this may take 5-15 minutes)...");
    let attempts = 0;
    const maxAttempts = 30; // 15 minutes max

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds
      attempts++;

      const status = sshCommand(
        config,
        `[ -f /var/opt/templates/noble-server-cloudimg-amd64.img ] && stat -c%s /var/opt/templates/noble-server-cloudimg-amd64.img 2>/dev/null || echo "0"`
      ).trim();

      const sizeBytes = parseInt(status) || 0;
      const sizeMB = Math.round(sizeBytes / 1024 / 1024);

      // Check if wget is still running
      const wgetRunning = sshCommand(
        config,
        `pgrep -f "wget.*noble-server" > /dev/null && echo "running" || echo "done"`
      ).trim();

      if (wgetRunning === "running") {
        printInfo(`Download in progress: ${sizeMB}MB downloaded (attempt ${attempts}/${maxAttempts})...`);
      } else if (sizeBytes > 500000000) { // > 500MB means likely complete
        printSuccess(`Download complete: ${sizeMB}MB`);
        break;
      } else if (sizeBytes > 0) {
        printInfo(`Download appears complete: ${sizeMB}MB`);
        break;
      } else {
        printWarning(`Download status unknown, checking again...`);
      }
    }

    if (attempts >= maxAttempts) {
      throw new Error("Download timed out. Check /var/opt/templates/download.log on XCP-ng host.");
    }
  } else {
    printSuccess("Ubuntu cloud image already exists");
  }

  // Step 2: Get SR UUID
  const srUuid = getStorageRepositoryUUID(config);
  printInfo(`Using storage repository: ${srUuid}`);

  // Step 3: Create VM from cloud image
  printInfo("Creating VM from cloud image...");

  // First, create a basic VM
  const vmUuid = sshCommand(
    config,
    `xe vm-install template="Other install media" new-name-label="${TEMPLATE_NAME}-temp" sr-uuid="${srUuid}"`
  ).trim();

  printInfo(`Created temporary VM: ${vmUuid}`);

  // Step 4: Import the disk
  printInfo("Importing cloud image as disk...");

  // Convert qcow2 to raw and import
  sshCommand(
    config,
    `qemu-img convert -f qcow2 -O raw /var/opt/templates/noble-server-cloudimg-amd64.img /var/opt/templates/ubuntu-2404.raw`
  );

  // Create VDI and import
  const vdiUuid = sshCommand(
    config,
    `xe vdi-create sr-uuid="${srUuid}" name-label="${TEMPLATE_NAME}-disk" type=user virtual-size=10737418240`
  ).trim();

  sshCommand(
    config,
    `xe vdi-import uuid="${vdiUuid}" filename=/var/opt/templates/ubuntu-2404.raw format=raw`
  );

  // Attach VDI to VM
  sshCommand(
    config,
    `xe vbd-create vm-uuid="${vmUuid}" vdi-uuid="${vdiUuid}" device=0 bootable=true type=Disk mode=RW`
  );

  // Step 5: Configure VM for cloud-init
  printInfo("Configuring VM for cloud-init...");

  sshCommand(
    config,
    `xe vm-param-set uuid="${vmUuid}" name-label="${TEMPLATE_NAME}"`
  );

  sshCommand(
    config,
    `xe vm-param-set uuid="${vmUuid}" name-description="${TEMPLATE_DESCRIPTION}"`
  );

  sshCommand(
    config,
    `xe vm-param-set uuid="${vmUuid}" memory-static-max=2147483648 memory-dynamic-max=2147483648 memory-dynamic-min=1073741824 memory-static-min=1073741824`
  );

  sshCommand(config, `xe vm-param-set uuid="${vmUuid}" VCPUs-max=4`);
  sshCommand(config, `xe vm-param-set uuid="${vmUuid}" VCPUs-at-startup=2`);

  // Enable cloud-init
  sshCommand(
    config,
    `xe vm-param-set uuid="${vmUuid}" other-config:install-methods=cdrom,http,ftp,nfs`
  );

  // Step 6: Convert to template
  printInfo("Converting to template...");
  sshCommand(config, `xe vm-param-set uuid="${vmUuid}" is-a-template=true`);

  // Cleanup
  printInfo("Cleaning up temporary files...");
  sshCommand(config, `rm -f /var/opt/templates/ubuntu-2404.raw`);

  printSuccess(`Template "${TEMPLATE_NAME}" created successfully!`);
}

async function createTemplateSimple(config: Config): Promise<void> {
  printInfo("Creating Ubuntu 24.04 template using simplified method...");

  // This method uses the built-in XCP-ng template and cloud-init
  const srUuid = getStorageRepositoryUUID(config);

  // Create from existing Ubuntu template if available
  let baseTemplate = sshCommand(
    config,
    `xe template-list name-label="Ubuntu Focal Fossa 20.04" --minimal`
  ).trim();

  if (!baseTemplate) {
    baseTemplate = sshCommand(
      config,
      `xe template-list name-label="Other install media" --minimal`
    ).trim();
  }

  if (!baseTemplate) {
    throw new Error("No suitable base template found");
  }

  printInfo(`Using base template: ${baseTemplate}`);

  // Create VM from template
  const vmUuid = sshCommand(
    config,
    `xe vm-install template="${baseTemplate}" new-name-label="${TEMPLATE_NAME}" sr-uuid="${srUuid}"`
  ).trim();

  // Configure
  sshCommand(
    config,
    `xe vm-param-set uuid="${vmUuid}" name-description="${TEMPLATE_DESCRIPTION}"`
  );
  sshCommand(
    config,
    `xe vm-param-set uuid="${vmUuid}" memory-static-max=2147483648`
  );
  sshCommand(config, `xe vm-param-set uuid="${vmUuid}" VCPUs-max=4`);
  sshCommand(config, `xe vm-param-set uuid="${vmUuid}" VCPUs-at-startup=2`);

  // Convert to template
  sshCommand(config, `xe vm-param-set uuid="${vmUuid}" is-a-template=true`);

  printSuccess(`Template "${TEMPLATE_NAME}" created!`);
  printWarning(
    "Note: This is a basic template. For cloud-init support, import the Ubuntu cloud image via XO UI."
  );
}

// =============================================================================
// Main Function
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force") || args.includes("-f");
  const simple = args.includes("--simple");

  console.log(`
╔════════════════════════════════════════════════════════════╗
║          UBUNTU 24.04 CLOUD-INIT TEMPLATE SETUP            ║
╚════════════════════════════════════════════════════════════╝
`);

  const config = getConfig();

  if (!config.xoPassword && !config.xcpngHost) {
    printError("No XO_PASSWORD or XCPNG_HOST configured in .claude/.env");
    process.exit(1);
  }

  // Check if template exists
  printInfo(`Checking for template: ${TEMPLATE_NAME}`);

  let exists = false;

  // Try XO API first
  if (config.xoPassword) {
    exists = await checkTemplateExistsXO(config);
  }

  // Fall back to SSH
  if (!exists && config.xcpngHost) {
    exists = checkTemplateExistsSSH(config);
  }

  if (exists && !force) {
    printSuccess(`Template "${TEMPLATE_NAME}" already exists!`);
    console.log(`
To recreate, run with --force flag:
  bun run CreateTemplate.ts --force
`);
    return;
  }

  if (exists && force) {
    printWarning(`Recreating template "${TEMPLATE_NAME}"...`);
    // Delete existing template
    try {
      const uuid = sshCommand(
        config,
        `xe template-list name-label="${TEMPLATE_NAME}" --minimal`
      ).trim();
      if (uuid) {
        sshCommand(config, `xe template-uninstall template-uuid="${uuid}" force=true`);
        printInfo("Removed existing template");
      }
    } catch {
      printWarning("Could not remove existing template, continuing...");
    }
  }

  // Create template
  try {
    if (simple) {
      await createTemplateSimple(config);
    } else {
      await createTemplateViaSSH(config);
    }
  } catch (error) {
    printError(`Template creation failed: ${(error as Error).message}`);
    console.log(`
Alternative: Create template manually via Xen Orchestra UI:
1. Go to Import > VM
2. Select "From URL"
3. Enter: ${UBUNTU_IMAGE_URL}
4. Name: ${TEMPLATE_NAME}
5. Enable Cloud-init
6. After import, right-click → Convert to template
`);
    process.exit(1);
  }

  console.log(`
╔════════════════════════════════════════════════════════════╗
║                    TEMPLATE READY                           ║
╚════════════════════════════════════════════════════════════╝

Template: ${TEMPLATE_NAME}
Description: ${TEMPLATE_DESCRIPTION}

You can now deploy Hashcrack infrastructure:
  hashcrack deploy --workers 3
`);
}

// Help
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
CreateTemplate - Create Ubuntu 24.04 Cloud-Init Template

Usage:
  bun run CreateTemplate.ts [options]

Options:
  --force, -f    Recreate template even if it exists
  --simple       Use simplified template (no cloud image download)
  --help, -h     Show this help

Environment Variables (in .claude/.env):
  XCPNG_HOST     XCP-ng host IP (default: 192.168.99.209)
  XCPNG_USER     SSH user (default: root)
  XCPNG_SR_NAME  Storage repository name (default: "Local storage")
  XO_HOST        Xen Orchestra URL (for API checks)
  XO_USER        XO username
  XO_PASSWORD    XO password
`);
  process.exit(0);
}

main().catch((error) => {
  printError(error.message);
  process.exit(1);
});
