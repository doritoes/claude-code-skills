#!/usr/bin/env bun
/**
 * Apply latest version updates to SoftwareCatalog.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const toolsDir = dirname(import.meta.path);
const catalogPath = resolve(toolsDir, "../data/SoftwareCatalog.json");
const updatesPath = resolve(toolsDir, "../data/latest-version-updates.json");

const catalog = JSON.parse(readFileSync(catalogPath, "utf-8"));
const updates = JSON.parse(readFileSync(updatesPath, "utf-8"));

let updateCount = 0;

for (const sw of catalog.software) {
  if (updates[sw.id] && !sw.latestVersion) {
    sw.latestVersion = updates[sw.id].latest;
    sw.lastChecked = new Date().toISOString().split("T")[0];
    updateCount++;
    console.log(`✓ ${sw.id}: ${sw.latestVersion}`);
  }
}

// Update metadata
catalog._metadata.lastUpdated = new Date().toISOString().split("T")[0];

// Write back
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

console.log("");
console.log(`Applied ${updateCount} latestVersion updates to catalog`);
