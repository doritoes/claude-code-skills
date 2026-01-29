#!/usr/bin/env bun
/**
 * ProviderControl.ts - Cloud provider API operations for FoldingAtCloud
 *
 * Interacts with cloud provider APIs (NOT SSH) for VM power management.
 * Includes mandatory safety checks before any destructive action.
 *
 * Commands:
 *   vm-state <provider> <vm-name>     Get VM power state from cloud API
 *   vm-list <provider>                List VMs from cloud API
 *   vm-stop <provider> <vm-name>      Stop VM (requires --confirm and safety check)
 *
 * SAFETY: vm-stop requires:
 *   1. FAH state verified as PAUSED via WorkerControl.ts
 *   2. Explicit --confirm flag
 *   3. Action logged to audit file
 *
 * Usage:
 *   bun run ProviderControl.ts vm-state azure foldingcloud-worker-1
 *   bun run ProviderControl.ts vm-list azure
 *   bun run ProviderControl.ts vm-stop azure foldingcloud-worker-1 --confirm --ip 20.120.1.100
 */

import { $ } from "bun";
import { existsSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// Paths
const SCRIPT_DIR = dirname(import.meta.path);
const SKILL_DIR = join(SCRIPT_DIR, "..");
const LOGS_DIR = join(SKILL_DIR, "logs");
const AUDIT_LOG = join(LOGS_DIR, "audit.log");

// Resource group names by provider
const RESOURCE_GROUPS: Record<string, string> = {
  azure: process.env.AZURE_RESOURCE_GROUP || "foldingcloud-rg",
};

interface VmState {
  provider: string;
  name: string;
  power_state: string;
  provisioning_state?: string;
  error?: string;
}

interface SafetyCheck {
  safe: boolean;
  reason: string;
  fah_paused?: boolean;
  vm_state?: string;
}

/**
 * Write to audit log
 */
function auditLog(
  action: string,
  provider: string,
  target: string,
  details: string,
  result: string
): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  const entry = `${timestamp} | ${action} | ${provider} | ${target} | ${details} | ${result}\n`;

  appendFileSync(AUDIT_LOG, entry);
}

/**
 * Get VM state from Azure
 */
async function getAzureVmState(vmName: string, resourceGroup?: string): Promise<VmState> {
  const rg = resourceGroup || RESOURCE_GROUPS.azure;

  try {
    const result = await $`az vm get-instance-view --name ${vmName} --resource-group ${rg} --query "{powerState:instanceView.statuses[1].displayStatus, provisioningState:provisioningState}" -o json 2>&1`.text();

    const parsed = JSON.parse(result);

    return {
      provider: "azure",
      name: vmName,
      power_state: parsed.powerState || "unknown",
      provisioning_state: parsed.provisioningState,
    };
  } catch (error: any) {
    return {
      provider: "azure",
      name: vmName,
      power_state: "error",
      error: error.message,
    };
  }
}

/**
 * Get VM state from OCI
 */
async function getOciVmState(vmName: string): Promise<VmState> {
  // OCI CLI is unreliable from this environment - use terraform instead
  try {
    const tfDir = join(SKILL_DIR, "terraform", "oci");
    if (!existsSync(tfDir)) {
      return {
        provider: "oci",
        name: vmName,
        power_state: "unknown",
        error: "OCI terraform directory not found",
      };
    }

    // Try terraform state
    const result = await $`cd ${tfDir} && terraform state list 2>/dev/null`.text();

    if (result.includes("oci_core_instance")) {
      // Get instance details
      const stateResult = await $`cd ${tfDir} && terraform show -json 2>/dev/null`.text();
      const state = JSON.parse(stateResult);

      for (const resource of state.values?.root_module?.resources || []) {
        if (resource.type === "oci_core_instance" && resource.values?.display_name?.includes(vmName)) {
          return {
            provider: "oci",
            name: vmName,
            power_state: resource.values.state || "unknown",
          };
        }
      }
    }

    return {
      provider: "oci",
      name: vmName,
      power_state: "not_found",
    };
  } catch (error: any) {
    return {
      provider: "oci",
      name: vmName,
      power_state: "error",
      error: error.message,
    };
  }
}

/**
 * List VMs from Azure
 */
async function listAzureVms(resourceGroup?: string): Promise<VmState[]> {
  const rg = resourceGroup || RESOURCE_GROUPS.azure;

  try {
    const result = await $`az vm list -g ${rg} --show-details --query "[].{name:name, powerState:powerState}" -o json 2>&1`.text();

    const vms = JSON.parse(result);

    return vms.map((vm: any) => ({
      provider: "azure",
      name: vm.name,
      power_state: vm.powerState || "unknown",
    }));
  } catch (error: any) {
    return [{
      provider: "azure",
      name: "error",
      power_state: "error",
      error: error.message,
    }];
  }
}

/**
 * List VMs from OCI (via terraform)
 */
async function listOciVms(): Promise<VmState[]> {
  try {
    const tfDir = join(SKILL_DIR, "terraform", "oci");
    if (!existsSync(tfDir)) {
      return [];
    }

    const result = await $`cd ${tfDir} && terraform show -json 2>/dev/null`.text();
    const state = JSON.parse(result);

    const vms: VmState[] = [];

    for (const resource of state.values?.root_module?.resources || []) {
      if (resource.type === "oci_core_instance") {
        vms.push({
          provider: "oci",
          name: resource.values?.display_name || resource.name,
          power_state: resource.values?.state || "unknown",
        });
      }
    }

    return vms;
  } catch (error: any) {
    return [];
  }
}

/**
 * SAFETY CHECK: Verify FAH is paused before allowing stop
 */
async function canSafelyStop(ip: string, provider: string): Promise<SafetyCheck> {
  // Call WorkerControl.ts can-stop
  try {
    const workerControlPath = join(SCRIPT_DIR, "WorkerControl.ts");
    const result = await $`bun run ${workerControlPath} can-stop ${ip} --provider ${provider} 2>&1`.text();

    const parsed = JSON.parse(result);

    return {
      safe: parsed.safe === true,
      reason: parsed.reason,
      fah_paused: parsed.status?.paused,
    };
  } catch (error: any) {
    return {
      safe: false,
      reason: `Safety check failed: ${error.message}`,
    };
  }
}

/**
 * Stop Azure VM (with safety checks)
 */
async function stopAzureVm(
  vmName: string,
  ip: string,
  confirmed: boolean,
  resourceGroup?: string
): Promise<{ success: boolean; message: string }> {
  const rg = resourceGroup || RESOURCE_GROUPS.azure;

  // SAFETY CHECK 1: --confirm flag required
  if (!confirmed) {
    auditLog("STOP_REJECTED", "azure", vmName, ip, "Missing --confirm flag");
    return {
      success: false,
      message: "SAFETY: --confirm flag required for vm-stop",
    };
  }

  // SAFETY CHECK 2: FAH must be paused
  const safetyCheck = await canSafelyStop(ip, "azure");
  if (!safetyCheck.safe) {
    auditLog("STOP_REJECTED", "azure", vmName, ip, `Safety check failed: ${safetyCheck.reason}`);
    return {
      success: false,
      message: `SAFETY: ${safetyCheck.reason}`,
    };
  }

  // All checks passed - proceed with stop
  auditLog("STOP_INITIATED", "azure", vmName, ip, "Safety checks passed");

  try {
    await $`az vm deallocate --name ${vmName} --resource-group ${rg} --no-wait 2>&1`.text();

    auditLog("STOP_SUCCESS", "azure", vmName, ip, "Deallocate command sent");

    return {
      success: true,
      message: `VM ${vmName} deallocate initiated. Verify with vm-state command.`,
    };
  } catch (error: any) {
    auditLog("STOP_FAILED", "azure", vmName, ip, error.message);
    return {
      success: false,
      message: `Failed to stop VM: ${error.message}`,
    };
  }
}

/**
 * Stop OCI VM (with safety checks)
 */
async function stopOciVm(
  vmName: string,
  ip: string,
  confirmed: boolean
): Promise<{ success: boolean; message: string }> {
  // SAFETY CHECK 1: --confirm flag required
  if (!confirmed) {
    auditLog("STOP_REJECTED", "oci", vmName, ip, "Missing --confirm flag");
    return {
      success: false,
      message: "SAFETY: --confirm flag required for vm-stop",
    };
  }

  // SAFETY CHECK 2: FAH must be paused
  const safetyCheck = await canSafelyStop(ip, "oci");
  if (!safetyCheck.safe) {
    auditLog("STOP_REJECTED", "oci", vmName, ip, `Safety check failed: ${safetyCheck.reason}`);
    return {
      success: false,
      message: `SAFETY: ${safetyCheck.reason}`,
    };
  }

  // OCI CLI is unreliable - recommend using console or terraform
  auditLog("STOP_MANUAL", "oci", vmName, ip, "OCI CLI unreliable - manual action required");

  return {
    success: false,
    message: "OCI CLI is unreliable from this environment. Please stop the VM manually via OCI Console or use terraform.",
  };
}

// =============================================================================
// Main CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(`
ProviderControl - Cloud provider API operations for FoldingAtCloud

Usage:
  bun run ProviderControl.ts <command> [args] [options]

Commands:
  vm-state <provider> <vm-name>     Get VM power state from cloud API
  vm-list <provider>                List VMs from cloud API
  vm-stop <provider> <vm-name>      Stop VM (requires safety checks)

Providers: azure, oci

Safety Requirements for vm-stop:
  1. FAH state must be PAUSED (verified via WorkerControl.ts can-stop)
  2. Must include --confirm flag
  3. Must include --ip <worker-ip> for safety verification
  4. Action is logged to audit file

Options:
  --confirm              Required for vm-stop
  --ip <address>         Worker IP for safety verification
  --resource-group <rg>  Azure resource group (default: foldingcloud-rg)

Examples:
  bun run ProviderControl.ts vm-state azure foldingcloud-worker-1
  bun run ProviderControl.ts vm-list azure
  bun run ProviderControl.ts vm-stop azure foldingcloud-worker-1 --confirm --ip 20.120.1.100

Audit Log: ${AUDIT_LOG}
`);
    process.exit(1);
  }

  const command = args[0];

  // Parse options
  const confirmed = args.includes("--confirm");

  let ip: string | undefined;
  const ipIdx = args.indexOf("--ip");
  if (ipIdx !== -1 && args[ipIdx + 1]) {
    ip = args[ipIdx + 1];
  }

  let resourceGroup: string | undefined;
  const rgIdx = args.indexOf("--resource-group");
  if (rgIdx !== -1 && args[rgIdx + 1]) {
    resourceGroup = args[rgIdx + 1];
  }

  switch (command) {
    case "vm-state": {
      const provider = args[1];
      const vmName = args[2];

      if (!provider || !vmName) {
        console.error("Usage: vm-state <provider> <vm-name>");
        process.exit(1);
      }

      let state: VmState;
      switch (provider) {
        case "azure":
          state = await getAzureVmState(vmName, resourceGroup);
          break;
        case "oci":
          state = await getOciVmState(vmName);
          break;
        default:
          console.error(`Unsupported provider: ${provider}`);
          process.exit(1);
      }

      console.log(JSON.stringify(state, null, 2));
      break;
    }

    case "vm-list": {
      const provider = args[1];

      if (!provider) {
        console.error("Usage: vm-list <provider>");
        process.exit(1);
      }

      let vms: VmState[];
      switch (provider) {
        case "azure":
          vms = await listAzureVms(resourceGroup);
          break;
        case "oci":
          vms = await listOciVms();
          break;
        default:
          console.error(`Unsupported provider: ${provider}`);
          process.exit(1);
      }

      console.log(JSON.stringify(vms, null, 2));
      break;
    }

    case "vm-stop": {
      const provider = args[1];
      const vmName = args[2];

      if (!provider || !vmName) {
        console.error("Usage: vm-stop <provider> <vm-name> --confirm --ip <address>");
        process.exit(1);
      }

      if (!ip) {
        console.error("SAFETY: --ip <address> required for safety verification");
        process.exit(1);
      }

      let result: { success: boolean; message: string };
      switch (provider) {
        case "azure":
          result = await stopAzureVm(vmName, ip, confirmed, resourceGroup);
          break;
        case "oci":
          result = await stopOciVm(vmName, ip, confirmed);
          break;
        default:
          console.error(`Unsupported provider: ${provider}`);
          process.exit(1);
      }

      console.log(JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
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
