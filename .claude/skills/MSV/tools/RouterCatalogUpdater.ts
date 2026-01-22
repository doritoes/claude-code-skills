/**
 * RouterCatalogUpdater.ts - Automated router catalog refresh
 *
 * Updates RouterCatalog.json with latest MSV data from NVD.
 * Can be run manually or scheduled for periodic updates.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { RouterNvdClient, type MsvCalculation } from "./RouterNvdClient";
import { loadCatalog } from "./RouterClient";
import type { RouterCatalog, RouterModel, HardwareVersion, FirmwareBranch } from "./RouterTypes";

// =============================================================================
// Types
// =============================================================================

export interface UpdateResult {
  modelId: string;
  previousMsv: string;
  newMsv: string | null;
  kevCves: string[];
  updated: boolean;
  error?: string;
}

export interface CatalogUpdateSummary {
  timestamp: string;
  modelsProcessed: number;
  modelsUpdated: number;
  modelsWithErrors: number;
  modelsSkipped: number;
  results: UpdateResult[];
}

// =============================================================================
// Updater
// =============================================================================

export class RouterCatalogUpdater {
  private nvdClient: RouterNvdClient;
  private cacheDir: string;
  private verbose: boolean;

  constructor(cacheDir: string, options?: { verbose?: boolean }) {
    this.cacheDir = cacheDir;
    this.verbose = options?.verbose ?? false;
    this.nvdClient = new RouterNvdClient(cacheDir, { verbose: this.verbose });

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Update a single model's MSV data
   */
  async updateModel(model: RouterModel): Promise<UpdateResult> {
    const result: UpdateResult = {
      modelId: model.id,
      previousMsv: this.getCurrentMsv(model),
      newMsv: null,
      kevCves: [],
      updated: false,
    };

    if (!model.cpePrefix) {
      result.error = "No CPE prefix defined";
      return result;
    }

    try {
      if (this.verbose) {
        console.log(`Processing ${model.displayName}...`);
      }

      const queryResult = await this.nvdClient.queryRouterMsv(model);

      if (queryResult.error) {
        result.error = queryResult.error;
        return result;
      }

      if (queryResult.calculation) {
        result.newMsv = queryResult.calculation.msv;
        result.kevCves = queryResult.calculation.kevCves;

        // Check if update is needed
        if (
          result.newMsv !== "unknown" &&
          result.newMsv !== result.previousMsv
        ) {
          result.updated = true;
        }
      }

      return result;
    } catch (error) {
      result.error = (error as Error).message;
      return result;
    }
  }

  /**
   * Get current MSV from model's default hardware version
   */
  private getCurrentMsv(model: RouterModel): string {
    const hwVersionKey = model.defaultHwVersion || Object.keys(model.hardwareVersions)[0];
    const hwVersion = model.hardwareVersions[hwVersionKey];
    if (!hwVersion) return "unknown";

    const branchKey = Object.keys(hwVersion.firmwareBranches)[0];
    const branch = hwVersion.firmwareBranches[branchKey];
    return branch?.msv || "unknown";
  }

  /**
   * Update the catalog with new MSV data
   */
  async updateCatalog(options: {
    dryRun?: boolean;
    modelsToUpdate?: string[];
    skipExisting?: boolean;
  } = {}): Promise<CatalogUpdateSummary> {
    const { dryRun = false, modelsToUpdate, skipExisting = false } = options;

    const summary: CatalogUpdateSummary = {
      timestamp: new Date().toISOString(),
      modelsProcessed: 0,
      modelsUpdated: 0,
      modelsWithErrors: 0,
      modelsSkipped: 0,
      results: [],
    };

    // Load current catalog
    const catalog = await loadCatalog();
    const models = Object.values(catalog.models);

    // Filter models if specific ones requested
    const targetModels = modelsToUpdate
      ? models.filter((m) => modelsToUpdate.includes(m.id))
      : models;

    if (this.verbose) {
      console.log(`\nUpdating ${targetModels.length} models...`);
      console.log(`Dry run: ${dryRun}`);
      console.log("");
    }

    // Process each model
    for (const model of targetModels) {
      // Skip models without CPE prefix
      if (!model.cpePrefix) {
        summary.modelsSkipped++;
        continue;
      }

      // Skip if existing MSV and skipExisting is true
      const currentMsv = this.getCurrentMsv(model);
      if (skipExisting && currentMsv !== "unknown") {
        summary.modelsSkipped++;
        continue;
      }

      summary.modelsProcessed++;

      const result = await this.updateModel(model);
      summary.results.push(result);

      if (result.error) {
        summary.modelsWithErrors++;
        if (this.verbose) {
          console.log(`  ${model.id}: ERROR - ${result.error}`);
        }
      } else if (result.updated) {
        summary.modelsUpdated++;
        if (this.verbose) {
          console.log(`  ${model.id}: ${result.previousMsv} -> ${result.newMsv}`);
        }

        // Apply update to catalog object (if not dry run)
        if (!dryRun) {
          this.applyUpdate(catalog, model.id, result);
        }
      } else {
        if (this.verbose) {
          console.log(`  ${model.id}: No change (${result.previousMsv})`);
        }
      }

      // Rate limit: wait between models to avoid hitting NVD limits
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Save updated catalog (if not dry run)
    if (!dryRun && summary.modelsUpdated > 0) {
      catalog.lastUpdated = new Date().toISOString().split("T")[0];
      await this.saveCatalog(catalog);
    }

    return summary;
  }

  /**
   * Apply an update result to the catalog
   */
  private applyUpdate(
    catalog: RouterCatalog,
    modelId: string,
    result: UpdateResult
  ): void {
    const model = catalog.models[modelId];
    if (!model || !result.newMsv || result.newMsv === "unknown") return;

    // Update all hardware versions
    for (const hwVersionKey of Object.keys(model.hardwareVersions)) {
      const hwVersion = model.hardwareVersions[hwVersionKey];

      // Update KEV CVEs
      if (result.kevCves.length > 0) {
        hwVersion.kevCves = [...new Set([...(hwVersion.kevCves || []), ...result.kevCves])];
      }

      // Update firmware branch MSV
      for (const branchKey of Object.keys(hwVersion.firmwareBranches)) {
        const branch = hwVersion.firmwareBranches[branchKey];
        if (!branch.eol) {
          branch.msv = result.newMsv;
          branch.msvDate = new Date().toISOString().split("T")[0];
        }
      }
    }
  }

  /**
   * Save the catalog to disk
   */
  private async saveCatalog(catalog: RouterCatalog): Promise<void> {
    const catalogPath = new URL("../data/RouterCatalog.json", import.meta.url);
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

    if (this.verbose) {
      console.log(`\nCatalog saved to ${catalogPath}`);
    }
  }

  /**
   * Format update summary for display
   */
  formatSummary(summary: CatalogUpdateSummary): string {
    const lines: string[] = [];

    lines.push("\n" + "=".repeat(60));
    lines.push("ROUTER CATALOG UPDATE SUMMARY");
    lines.push("=".repeat(60));
    lines.push(`Timestamp: ${summary.timestamp}`);
    lines.push(`Models Processed: ${summary.modelsProcessed}`);
    lines.push(`Models Updated: ${summary.modelsUpdated}`);
    lines.push(`Models With Errors: ${summary.modelsWithErrors}`);
    lines.push(`Models Skipped: ${summary.modelsSkipped}`);

    if (summary.modelsUpdated > 0) {
      lines.push("\nUpdates:");
      for (const result of summary.results.filter((r) => r.updated)) {
        lines.push(`  ${result.modelId}: ${result.previousMsv} -> ${result.newMsv}`);
        if (result.kevCves.length > 0) {
          lines.push(`    KEV CVEs: ${result.kevCves.join(", ")}`);
        }
      }
    }

    if (summary.modelsWithErrors > 0) {
      lines.push("\nErrors:");
      for (const result of summary.results.filter((r) => r.error)) {
        lines.push(`  ${result.modelId}: ${result.error}`);
      }
    }

    lines.push("=".repeat(60));

    return lines.join("\n");
  }

  /**
   * Query a single model for MSV info (without updating catalog)
   */
  async queryModel(modelId: string): Promise<string> {
    const catalog = await loadCatalog();
    const model = catalog.models[modelId];

    if (!model) {
      return `Error: Model "${modelId}" not found in catalog`;
    }

    const result = await this.nvdClient.queryRouterMsv(model);
    return this.nvdClient.formatResult(result);
  }
}

// =============================================================================
// CLI Entry Point (when run directly)
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const dryRun = args.includes("--dry-run");
  const skipExisting = args.includes("--skip-existing");

  // Get cache directory
  const cacheDir = resolve(
    dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
    "../.cache"
  );

  const updater = new RouterCatalogUpdater(cacheDir, { verbose });

  // Check for query mode
  const queryIdx = args.indexOf("--query");
  if (queryIdx !== -1 && args[queryIdx + 1]) {
    const modelId = args[queryIdx + 1];
    updater.queryModel(modelId).then((output) => {
      console.log(output);
    });
  } else {
    // Full update mode
    console.log("Starting router catalog update...");
    console.log(`Options: dry-run=${dryRun}, skip-existing=${skipExisting}, verbose=${verbose}`);

    updater
      .updateCatalog({ dryRun, skipExisting })
      .then((summary) => {
        console.log(updater.formatSummary(summary));
      })
      .catch((error) => {
        console.error("Update failed:", error);
        process.exit(1);
      });
  }
}
