#!/usr/bin/env bun
/**
 * Batch fetch latest versions for MSV catalog products
 */

import { EndOfLifeClient, PRODUCT_MAPPING } from "./EndOfLifeClient";
import { ChocolateyClient, CHOCO_PACKAGE_MAP } from "./ChocolateyClient";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const toolsDir = dirname(import.meta.path);
const catalogPath = resolve(toolsDir, "../data/SoftwareCatalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf-8"));

interface Update {
  latest: string;
  source: string;
  displayName: string;
}

async function main() {
  const dataDir = resolve(toolsDir, "../data");
  const eolClient = new EndOfLifeClient(resolve(dataDir, "eol"));
  const chocoClient = new ChocolateyClient(dataDir);

  const updates: Record<string, Update> = {};

  // Products without latestVersion
  const missing = catalog.software.filter((s: any) => !s.latestVersion);
  console.log(`Processing ${missing.length} products without latestVersion...`);
  console.log("");

  for (const sw of missing) {
    const id = sw.id;
    let latest: string | null = null;
    let source: string | null = null;

    // Try Chocolatey first (faster, more specific to Windows)
    const chocoId = id.toLowerCase();
    if (CHOCO_PACKAGE_MAP[chocoId]) {
      try {
        latest = await chocoClient.getLatestVersion(id);
        if (latest) source = "chocolatey";
      } catch {
        // ignore
      }
    }

    // Try endoflife.date
    const eolId = id.toLowerCase();
    if (!latest && PRODUCT_MAPPING[eolId]) {
      try {
        const data = await eolClient.getProduct(id);
        if (data?.cycles?.length) {
          latest = data.cycles[0].latest;
          source = "endoflife.date";
        }
      } catch {
        // ignore
      }
    }

    if (latest) {
      updates[id] = { latest, source: source!, displayName: sw.displayName };
      console.log(`✓ ${id.padEnd(30)} ${latest.padEnd(15)} ${source}`);
    }
  }

  console.log("");
  console.log("=== Summary ===");
  console.log(`Products updated: ${Object.keys(updates).length}`);
  console.log(`Products still missing: ${missing.length - Object.keys(updates).length}`);

  // Write updates to file for review
  const outputPath = resolve(dataDir, "latest-version-updates.json");
  writeFileSync(outputPath, JSON.stringify(updates, null, 2));
  console.log("");
  console.log(`Updates saved to ${outputPath}`);
}

main().catch(console.error);
